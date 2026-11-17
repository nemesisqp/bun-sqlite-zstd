// Transparent row-level compression end to end through Bun.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// Windows releases SQLite file locks asynchronously after close(), so a
// plain rmSync in `finally` flakes with EBUSY there. Retry briefly.
function removeDir(dir: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err: any) {
      if (attempt === 9 || (err?.code !== "EBUSY" && err?.code !== "EPERM")) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

const rowJson = (i: number) =>
  JSON.stringify({
    i,
    msg: "voice studio render finished",
    payload: "x".repeat(500),
    ts: "2026-11-16T10:00:00Z",
  });

function tempDb(): { db: Db; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bun-sqlite-zstd-"));
  const file = join(dir, "test.db");
  const db = openDatabase(file);
  return { db, file, dir };
}

function insertRows(d: Db, n: number) {
  const ins = d.prepare("insert into events(data) values (?)");
  d.exec("BEGIN");
  for (let i = 0; i < n; i++) ins.run(rowJson(i));
  d.exec("COMMIT");
}

describe("transparent compression", () => {
  test("2000 rows shrink by >80% after maintenance + VACUUM, reads stay correct", () => {
    const { db, file, dir } = tempDb();
    try {
      db.exec("pragma busy_timeout=5000; create table events(id integer primary key, data text);");
      insertRows(db, 2000);
      const before = Bun.file(file).size;
      expect(before).toBeGreaterThan(1_000_000);

      const enabled = db
        .query(
          `select zstd_enable_transparent('{"table": "events", "column": "data", "compression_level": 19, "dict_chooser": "''a''"}') as r`,
        )
        .get();
      expect(enabled.r).toBe("Done!");

      const more = db.query("select zstd_incremental_maintenance(null, 1) as more").get();
      expect(more.more).toBe(0);

      const stored = db
        .query("select count(*) as n, avg(length(data)) as avg from _events_zstd")
        .get();
      expect(stored.n).toBe(2000);
      expect(stored.avg).toBeLessThan(100); // was ~585B uncompressed

      db.exec("vacuum;");
      const after = Bun.file(file).size;
      expect(after).toBeLessThan(before * 0.2);

      // Reads through the view return the original data.
      const r = db.query("select data from events where id = 1500").get();
      expect(JSON.parse(r.data).i).toBe(1499);
      const first = db.query("select data from events where id = 1").get();
      expect(JSON.parse(first.data).i).toBe(0);

      // UPDATE and DELETE through the view keep working.
      db.prepare("update events set data = ? where id = 7").run(
        JSON.stringify({ i: 7, msg: "updated", payload: "y".repeat(10) }),
      );
      expect(JSON.parse(db.query("select data from events where id = 7").get().data).msg).toBe(
        "updated",
      );
      db.prepare("delete from events where id = 8").run();
      expect(db.query("select count(*) as n from events").get().n).toBe(1999);

      // A fresh connection sees the same data (extension reloads per connection).
      db.close();
      const db2 = openDatabase(file) as Db;
      const again = db2.query("select data from events where id = 1500").get();
      expect(JSON.parse(again.data).i).toBe(1499);
      db2.close();
    } finally {
      try {
        db.close();
      } catch {
        // already closed above
      }
      removeDir(dir);
    }
  });

  test("WITHOUT ROWID table with TEXT primary key compresses via PK-chunked maintenance", () => {
    // Regression test: maintenance used `where rowid in (select rowid ...)`
    // and failed with "no such column: rowid" on WITHOUT ROWID tables as
    // soon as the group was big enough to train a dictionary.
    const { db, file, dir } = tempDb();
    try {
      db.exec(
        "pragma busy_timeout=5000; create table urls(shortId text primary key, url text not null, createTime integer not null) without rowid;",
      );
      const ins = db.prepare("insert into urls(shortId, url, createTime) values (?,?,?)");
      db.exec("BEGIN");
      for (let i = 0; i < 2000; i++) {
        ins.run(
          `u${String(i).padStart(6, "0")}`,
          `https://example.com/articles/${i}/how-to-build-a-fast-url-shortener-with-bun-and-sqlite?utm_source=newsletter&ref=${i} ${"x".repeat(500)}`,
          1794000000000 + i,
        );
      }
      db.exec("COMMIT");
      const before = Bun.file(file).size;
      expect(before).toBeGreaterThan(1_000_000);

      db.query(
        `select zstd_enable_transparent('{"table": "urls", "column": "url", "compression_level": 3, "dict_chooser": "''a''"}')`,
      ).get();
      const more = db.query("select zstd_incremental_maintenance(null, 1) as more").get();
      expect(more.more).toBe(0);

      const stored = db
        .query("select count(*) as n, sum(length(url)) as total from _urls_zstd")
        .get();
      expect(stored.n).toBe(2000);
      expect(stored.total).toBeLessThan(before * 0.2);
      const uncompressed = db
        .query("select count(*) as n from _urls_zstd where _url_dict is null")
        .get();
      expect(uncompressed.n).toBe(0);

      db.exec("vacuum;");
      expect(Bun.file(file).size).toBeLessThan(before * 0.5);

      const r = db.query("select url from urls where shortId = 'u001500'").get();
      expect(r.url).toContain("how-to-build-a-fast-url-shortener");
      db.prepare("update urls set url = ? where shortId = ?").run(
        "https://example.com/updated",
        "u000001",
      );
      expect(db.query("select url from urls where shortId = 'u000001'").get().url).toBe(
        "https://example.com/updated",
      );
      db.prepare("delete from urls where shortId = ?").run("u000002");
      expect(db.query("select count(*) as n from urls").get().n).toBe(1999);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
      removeDir(dir);
    }
  });

  test("small tables stay uncompressed (upstream dict-size threshold)", () => {
    // A group needs total_bytes * 0.01 >= 5000 before a dictionary is
    // trained, so ~100 small rows are deliberately left alone.
    const { db, dir } = tempDb();
    try {
      db.exec("pragma busy_timeout=5000; create table events(id integer primary key, data text);");
      insertRows(db, 100);
      db.query(
        `select zstd_enable_transparent('{"table": "events", "column": "data", "compression_level": 19, "dict_chooser": "''a''"}')`,
      ).get();
      const more = db.query("select zstd_incremental_maintenance(null, 1) as more").get();
      expect(more.more).toBe(0);
      const compressed = db
        .query("select count(*) as n from _events_zstd where _data_dict is not null")
        .get();
      expect(compressed.n).toBe(0);
      expect(JSON.parse(db.query("select data from events where id = 42").get().data).i).toBe(41);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
      removeDir(dir);
    }
  });
});
