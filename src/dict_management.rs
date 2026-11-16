use anyhow::Context as AContext;
use lru_time_cache::LruCache;
use rusqlite::Connection;
use rusqlite::{functions::Context, params};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::LazyLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use zstd::dict::{DecoderDictionary, EncoderDictionary};

type EncoderCache = LruCache<(usize, i32, i32), Arc<EncoderDictionary<'static>>>;
// we cache the instantiated encoder dictionaries keyed by (DbConnection, dict_id, compression_level)
// DbConnection would ideally be db.path() because it's the same for multiple connections to the same db, but that would be less robust (e.g. in-memory databases)
// we use a Mutex and not a RwLock because even the .get() methods on LruCache need to write (to update expiry and least recently used time)
static ENCODER_DICTS: LazyLock<Mutex<EncoderCache>> =
    LazyLock::new(|| Mutex::new(LruCache::with_expiry_duration(Duration::from_secs(10))));

type DecoderCache = LruCache<(usize, i32), Arc<DecoderDictionary<'static>>>;
static DECODER_DICTS: LazyLock<Mutex<DecoderCache>> =
    LazyLock::new(|| Mutex::new(LruCache::with_expiry_duration(Duration::from_secs(10))));

/// when we open a new connection, it may reuse the same pointer location as an old connection, so we need to invalidate parts of the dict cache
pub(crate) fn invalidate_caches(_db: &Connection) {
    // (theoretically we only need to clear caches with key db_handle_pointer but it likely doesn't matter much,
    // how often are you going to open a new connection?)
    // let db_handle_pointer = unsafe { db.handle() } as usize;
    log::debug!("Invalidating dict caches");
    {
        let mut cache = ENCODER_DICTS.lock().unwrap();
        cache.clear();
    }
    {
        let mut cache = DECODER_DICTS.lock().unwrap();
        cache.clear();
    }
}
// TODO: the rust interface currently requires a level when preparing a dictionary, but the zstd interface (ZSTD_CCtx_loadDictionary) does not.
// TODO: Using LruCache here isn't very smart
pub fn encoder_dict_from_ctx(
    ctx: &Context,
    arg_index: usize,
    level: i32,
) -> anyhow::Result<Arc<EncoderDictionary<'static>>> {
    let id: i32 = ctx.get(arg_index)?;
    let db = unsafe { ctx.get_connection()? }; // SAFETY: This might be unsafe depending on how the connection is used. See https://github.com/rusqlite/rusqlite/issues/643#issuecomment-640181213
    let db_handle_pointer = unsafe { db.handle() } as usize; // SAFETY: We're only getting the pointer as an int, not using the raw connection

    let mut dicts_write = ENCODER_DICTS.lock().unwrap();
    let entry = dicts_write.entry((db_handle_pointer, id, level));
    let res = match entry {
        lru_time_cache::Entry::Vacant(e) => e.insert({
            log::debug!(
                "loading encoder dictionary {} level {} (should only happen once per 10s)",
                id,
                level
            );

            let dict_raw: Vec<u8> = db
                .query_row(
                    "select dict from _zstd_dicts where id = ?",
                    params![id],
                    |r| r.get(0),
                )
                .with_context(|| format!("getting dict with id={id} from _zstd_dicts"))?;
            let dict = EncoderDictionary::copy(&dict_raw, level);
            Arc::new(dict)
        }),
        lru_time_cache::Entry::Occupied(o) => o.into_mut(),
    }
    .clone();
    Ok(res)
}

pub fn decoder_dict_from_ctx(
    ctx: &Context,
    arg_index: usize,
) -> anyhow::Result<Arc<DecoderDictionary<'static>>> {
    // we cache the instantiated decoder dictionaries keyed by (DbConnection, dict_id)
    // DbConnection would ideally be db.path() because it's the same for multiple connections to the same db, but that would be less robust (e.g. in-memory databases)
    let id: i32 = ctx.get(arg_index)?;
    let db = unsafe { ctx.get_connection()? }; // SAFETY: This might be unsafe depending on how the connection is used. See https://github.com/rusqlite/rusqlite/issues/643#issuecomment-640181213
    let db_handle_pointer = unsafe { db.handle() } as usize; // SAFETY: We're only getting the pointer as an int, not using the raw connection
    log::trace!("Using DB Handle pointer {db_handle_pointer} as cache key");
    let cache_key = (db_handle_pointer, id);
    // since the get() function on lru cache also writes (updates last used time and expiry),
    // we can not use DICTS.read() (RwLock) for perf
    let mut dicts_write = DECODER_DICTS.lock().unwrap();
    let entry = dicts_write.entry(cache_key);
    let res = match entry {
        lru_time_cache::Entry::Vacant(e) => e.insert({
            log::debug!(
                "loading decoder dictionary {} (should only happen once per 10s)",
                id
            );
            let db = unsafe { ctx.get_connection()? };
            let dict_raw: Vec<u8> = db
                .query_row(
                    "select dict from _zstd_dicts where id = ?",
                    params![id],
                    |r| r.get(0),
                )
                .with_context(|| format!("getting dict with id={id} from _zstd_dicts"))?;
            let dict = DecoderDictionary::copy(&dict_raw);
            Arc::new(dict)
        }),
        lru_time_cache::Entry::Occupied(o) => o.into_mut(),
    }
    .clone();
    Ok(res)
}

/// Blob-passed dictionaries, cached by content.
///
/// `zstd_compress(data, level, dict_blob)` / `zstd_decompress(data, ...,
/// dict_blob)` used to re-prepare the dictionary on every call
/// (`Compressor::with_dictionary` / `DecoderDictionary::copy`), measured
/// at ~273µs/call for compress vs ~28µs when the same dictionary is
/// referenced by id. A blob dictionary is content-addressed, so caching it
/// can never go stale: the key is (hash, length[, level]) and the full
/// bytes are verified on a hit, which also makes a hash collision harmless
/// (worst case it just rebuilds the dictionary). The cache is bounded
/// (32 entries) and entries expire after 10 minutes.
const BLOB_DICT_TTL: Duration = Duration::from_secs(600);
const MAX_BLOB_DICTS: usize = 32;

type BlobEncoderCache = LruCache<(u64, usize, i32), (Vec<u8>, Arc<EncoderDictionary<'static>>)>;
static ENCODER_BLOB_DICTS: LazyLock<Mutex<BlobEncoderCache>> = LazyLock::new(|| {
    Mutex::new(LruCache::with_expiry_duration_and_capacity(
        BLOB_DICT_TTL,
        MAX_BLOB_DICTS,
    ))
});
type BlobDecoderCache = LruCache<(u64, usize), (Vec<u8>, Arc<DecoderDictionary<'static>>)>;
static DECODER_BLOB_DICTS: LazyLock<Mutex<BlobDecoderCache>> = LazyLock::new(|| {
    Mutex::new(LruCache::with_expiry_duration_and_capacity(
        BLOB_DICT_TTL,
        MAX_BLOB_DICTS,
    ))
});

fn hash_dict_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

pub fn encoder_dict_from_blob(
    dict_raw: &[u8],
    level: i32,
) -> anyhow::Result<Arc<EncoderDictionary<'static>>> {
    let key = (hash_dict_bytes(dict_raw), dict_raw.len(), level);
    let mut cache = ENCODER_BLOB_DICTS.lock().unwrap();
    if let Some((stored, dict)) = cache.get(&key)
        && stored.as_slice() == dict_raw
    {
        return Ok(dict.clone());
    }
    log::debug!("preparing encoder dictionary from blob (level {level})");
    let dict = Arc::new(EncoderDictionary::copy(dict_raw, level));
    cache.insert(key, (dict_raw.to_vec(), dict.clone()));
    Ok(dict)
}

pub fn decoder_dict_from_blob(dict_raw: &[u8]) -> anyhow::Result<Arc<DecoderDictionary<'static>>> {
    let key = (hash_dict_bytes(dict_raw), dict_raw.len());
    let mut cache = DECODER_BLOB_DICTS.lock().unwrap();
    if let Some((stored, dict)) = cache.get(&key)
        && stored.as_slice() == dict_raw
    {
        return Ok(dict.clone());
    }
    log::debug!("preparing decoder dictionary from blob");
    let dict = Arc::new(DecoderDictionary::copy(dict_raw));
    cache.insert(key, (dict_raw.to_vec(), dict.clone()));
    Ok(dict)
}

/*


use rusqlite::{functions::Context, params, types::ValueRef};

/// load a dict from sqlite function parameters
///
/// sqlite sadly does not do auxdata caching for subqueries like `zstd_compress(data, 3, (select dict from _zstd_dicts where id = 4))`
/// so instead we support the syntax `zstd_compress(data, 3, 4)` as an alias to the above
/// if the dict parameter is a number, the dict will be queried from the _zstd_dicts table and cached in sqlite auxdata
/// so it is only constructed once per query
///
/// this function is not 100% correct because the level is passed separately from the dictionary but the dictionary is cached in the aux data of the dictionary parameter
/// e.g. `select zstd_compress(tbl.data, tbl.row_compression_level, 123) from tbl` will probably compress all the data with the same compression ratio instead of a random one
/// as a workaround `select zstd_compress(tbl.data, tbl.row_compression_level, (select 123)) from tbl` probably works
/// to fix this the level parameter would need to be checked against the constructed dictionary and the dict discarded on mismatch
pub fn encoder_dict_from_ctx<'a>(
    ctx: &'a Context,
    arg_index: usize,
    level: i32,
) -> rusqlite::Result<Arc<OwnedEncoderDict<'a>>> {
    Ok(match ctx.get_aux::<OwnedEncoderDict>(arg_index as i32)? {
        Some(d) => d,
        None => {
            log::debug!("loading dictionary (should only happen once per query)");
            let dict_raw = match ctx.get_raw(arg_index) {
                ValueRef::Blob(b) => b.to_vec(),
                ValueRef::Integer(i) => {
                    let db = unsafe { ctx.get_connection()? };
                    let res: Vec<u8> = db.query_row(
                        "select dict from _zstd_dicts where id = ?",
                        params![i],
                        |r| r.get(0),
                    )?;
                    res
                }
                e => {
                    return Err(rusqlite::Error::InvalidFunctionParameterType(
                        arg_index,
                        e.data_type(),
                    ))
                }
            };
            let dict = wrap_encoder_dict(dict_raw, level);
            ctx.set_aux(arg_index as i32, dict)?;
            ctx.get_aux::<OwnedEncoderDict>(arg_index as i32)?.unwrap()
        }
    })
}


/// same as above
pub fn decoder_dict_from_ctx<'a>(
    ctx: &'a Context,
    arg_index: usize,
) -> rusqlite::Result<Arc<OwnedDecoderDict<'a>>> {
    Ok(match ctx.get_aux::<OwnedDecoderDict>(arg_index as i32)? {
        Some(d) => d,
        None => {
            log::debug!("loading dictionary (should only happen once per query)");
            let dict_raw = /*ctx.get::<Vec<u8>>(arg_index)?;*/
            match ctx.get_raw(arg_index) {
                ValueRef::Blob(b) => b.to_vec(),
                ValueRef::Integer(i) => {
                    let db = unsafe { ctx.get_connection()? };
                    let res: Vec<u8> = db.query_row(
                        "select dict from _zstd_dicts where id = ?",
                        params![i],
                        |r| r.get(0),
                    )?;
                    res
                }
                e => return Err(rusqlite::Error::InvalidFunctionParameterType(
                    arg_index,
                    e.data_type(),
                )),
            };
            let dict = wrap_decoder_dict(dict_raw);
            ctx.set_aux(arg_index as i32, dict)?;
            ctx.get_aux::<OwnedDecoderDict>(arg_index as i32)?.unwrap()
        }
    })
}
*/
