// Benchmarks for the bundled extension (this machine only).
// Run with `npm run bench`. Numbers go in README.md.
import { openDatabase } from "../index.js";

const db = openDatabase(":memory:") as any;

const MB = new Uint8Array(1_000_000);
for (let i = 0; i < MB.length; i++) MB[i] = (i * 31 + (i >> 8)) & 0xff;
const row = JSON.stringify({ msg: "voice studio render finished", payload: "x".repeat(500) });

function bench(name: string, iters: number, fn: () => void) {
  fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  const perCallUs = ((ms / iters) * 1000).toFixed(1);
  console.log(`${name}: ${perCallUs} µs/call (${(iters / (ms / 1000)).toFixed(0)}/s)`);
  return ms / iters;
}

function benchMB(name: string, iters: number, fn: () => Uint8Array) {
  let out: Uint8Array = fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) out = fn();
  const ms = performance.now() - t0;
  const mbps = (iters * 1) / (ms / 1000);
  console.log(`${name}: ${mbps.toFixed(0)} MB/s (${(ms / iters).toFixed(2)} ms/call)`);
  return out;
}

console.log("== compress 1MB ==");
for (const level of [3, 9, 19]) {
  benchMB(`level ${level}`, 20, () => db.query("select zstd_compress(?, ?) as c").get(MB, level).c);
}
console.log("== decompress 1MB (level 9) ==");
const c9 = db.query("select zstd_compress(?, 9) as c").get(MB).c;
benchMB("decompress", 20, () => db.query("select zstd_decompress(?, 0) as o").get(c9).o);

console.log("== 585B row, per call ==");
for (const level of [3, 9]) {
  bench(`compress lvl${level}`, 2000, () =>
    db.query("select zstd_compress(?, ?) as c").get(row, level),
  );
}
const cRow = db.query("select zstd_compress(?, 9) as c").get(row).c;
bench("decompress", 2000, () => db.query("select zstd_decompress(?, 0) as o").get(cRow));

console.log("== dict-blob vs dict-int (585B row, level 9) ==");
db.exec("create table docs(id integer primary key, body text);");
{
  const ins = db.prepare("insert into docs(body) values (?)");
  db.exec("BEGIN");
  for (let i = 0; i < 200; i++) ins.run(`log ${i}: ${"abc ".repeat(20)}`);
  db.exec("COMMIT");
}
const dict = db.query("select zstd_train_dict(body, 8192, 100) as d from docs").get().d;
db.exec("create table _zstd_dicts(id integer primary key, dict blob);");
db.prepare("insert into _zstd_dicts(id, dict) values (1, ?)").run(dict);
const sample = db.query("select body from docs limit 1").get().body;
bench("compress dict-int", 2000, () => db.query("select zstd_compress(?, 9, 1) as c").get(sample));
bench("compress dict-blob", 2000, () => db.query("select zstd_compress(?, 9, ?) as c").get(sample, dict));
const cDict = db.query("select zstd_compress(?, 9, 1) as c").get(sample).c;
bench("decompress dict-int", 2000, () => db.query("select zstd_decompress(?, 1, 1) as o").get(cDict));
bench("decompress dict-blob", 2000, () => db.query("select zstd_decompress(?, 1, ?) as o").get(cDict, dict));

console.log("== transparent maintenance, 2000 rows ==");
{
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "bun-sqlite-zstd-bench-"));
  const file = join(dir, "bench.db");
  const db2 = openDatabase(file) as any;
  db2.exec("pragma busy_timeout=5000; create table events(id integer primary key, data text);");
  const ins = db2.prepare("insert into events(data) values (?)");
  db2.exec("BEGIN");
  for (let i = 0; i < 2000; i++) ins.run(row);
  db2.exec("COMMIT");
  db2.query(
    `select zstd_enable_transparent('{"table": "events", "column": "data", "compression_level": 19, "dict_chooser": "''a''"}')`,
  ).get();
  // No warm-up here: the first maintenance call does all the work.
  const t0 = performance.now();
  db2.query("select zstd_incremental_maintenance(null, 1) as m").get();
  console.log(`maintenance (2000 rows): ${(performance.now() - t0).toFixed(1)} ms`);
  db2.close();
}
db.close();
