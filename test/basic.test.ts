// Basic zstd_compress / zstd_decompress behaviour through Bun.
import { describe, test, expect } from "bun:test";
import { openDatabase } from "../index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function db(): Db {
  return openDatabase(":memory:");
}

const text = "the quick brown fox jumps over the lazy dog. ".repeat(2000); // 90kB

describe("roundtrip", () => {
  test("text at levels 3, 9 and 19", () => {
    const d = db();
    for (const level of [3, 9, 19]) {
      const row = d
        .query("select zstd_decompress(zstd_compress(?, ?), 1) as out")
        .get(text, level);
      expect(row.out).toBe(text);
    }
    d.close();
  });

  test("blob roundtrip (is_text = false)", () => {
    const d = db();
    const input = new Uint8Array([0, 1, 2, 3, 255, 254, 0, 128, 64]);
    const compressed = d.query("select zstd_compress(?) as c").get(input).c;
    expect(compressed).toBeInstanceOf(Uint8Array);
    const back = d.query("select zstd_decompress(?, 0) as out").get(compressed).out;
    expect(new Uint8Array(back)).toEqual(input);
    d.close();
  });

  test("empty string and NULL passthrough", () => {
    const d = db();
    const empty = d.query("select zstd_decompress(zstd_compress('', 3), 1) as out").get();
    expect(empty.out).toBe("");
    const nul = d.query("select zstd_compress(NULL, 3) as c").get();
    expect(nul.c).toBeNull();
    const nul2 = d.query("select zstd_decompress(NULL, 1) as out").get();
    expect(nul2.out).toBeNull();
    d.close();
  });

  test("compression ratio on repetitive text", () => {
    const d = db();
    const row = d
      .query("select length(zstd_compress(?, 3)) as c3, length(zstd_compress(?, 9)) as c9, length(?) as ol")
      .get(text, text, text);
    expect(row.ol).toBe(90000);
    expect(row.c3).toBeLessThan(1000);
    expect(row.c9).toBeLessThanOrEqual(row.c3);
    d.close();
  });

  test("compact mode roundtrips only with compact=true on both sides", () => {
    const d = db();
    const row = d
      .query("select zstd_decompress(zstd_compress(?, 3, null, 1), 1, null, 1) as out")
      .get(text);
    expect(row.out).toBe(text);
    d.close();
  });
});

describe("dictionaries", () => {
  function trainDict(d: Db): Uint8Array {
    d.exec("create table docs(id integer primary key, body text);");
    const ins = d.prepare("insert into docs(body) values (?)");
    d.exec("BEGIN");
    for (let i = 0; i < 200; i++) {
      ins.run(`log entry ${i}: user opened /src/voice-studio/src/lib/${i % 7}.ts and edited ${"abc ".repeat(20)}`);
    }
    d.exec("COMMIT");
    const row = d.query("select zstd_train_dict(body, 8192, 100) as d from docs").get();
    return row.d as Uint8Array;
  }

  test("dict by id: compress + decompress roundtrip", () => {
    const d = db();
    const dict = trainDict(d);
    d.exec("create table _zstd_dicts(id integer primary key, dict blob);");
    d.prepare("insert into _zstd_dicts(id, dict) values (1, ?)").run(dict);
    const sample = d.query("select body from docs limit 1").get().body as string;
    const row = d
      .query("select zstd_decompress(zstd_compress(?, 19, 1), 1, 1) as out")
      .get(sample);
    expect(row.out).toBe(sample);
    d.close();
  });

  test("dict by blob: same bytes as by id, stable across repeated calls", () => {
    const d = db();
    const dict = trainDict(d);
    d.exec("create table _zstd_dicts(id integer primary key, dict blob);");
    d.prepare("insert into _zstd_dicts(id, dict) values (1, ?)").run(dict);
    const sample = d.query("select body from docs limit 1").get().body as string;
    const byId = d.query("select zstd_compress(?, 19, 1) as c").get(sample).c;
    for (let i = 0; i < 5; i++) {
      const byBlob = d.query("select zstd_compress(?, 19, ?) as c").get(sample, dict).c;
      expect(new Uint8Array(byBlob)).toEqual(new Uint8Array(byId));
    }
    const back = d
      .query("select zstd_decompress(?, 1, ?) as out")
      .get(byId, dict).out;
    expect(back).toBe(sample);
    d.close();
  });

  test("dict by blob: a second dict is not confused with the first", () => {
    const d = db();
    const dict = trainDict(d);
    const dict2 = d.query("select zstd_train_dict(body, 4096, 50) as d from docs").get()
      .d as Uint8Array;
    expect(Buffer.from(dict2).equals(Buffer.from(dict))).toBe(false);
    const sample = d.query("select body from docs limit 1").get().body as string;
    const c1 = d.query("select zstd_compress(?, 9, ?) as c").get(sample, dict).c;
    const c2 = d.query("select zstd_compress(?, 9, ?) as c").get(sample, dict2).c;
    expect(d.query("select zstd_decompress(?, 1, ?) as out").get(c1, dict).out).toBe(sample);
    expect(d.query("select zstd_decompress(?, 1, ?) as out").get(c2, dict2).out).toBe(sample);
    // First dict still works after the second was used (cache correctness).
    expect(d.query("select zstd_decompress(?, 1, ?) as out").get(c1, dict).out).toBe(sample);
    d.close();
  });
});

describe("error behaviour (upstream, pinned here)", () => {
  test("corrupt input errors instead of silently returning empty", () => {
    // With the bundled zstd 1.5.7 (this fork), invalid data raises an
    // error instead of the silent empty string upstream returned with
    // zstd 1.5.2. Empty input and a bare magic still decode to "".
    const d = db();
    for (const hex of ["00ff", "282b4d18", "ffffffff"]) {
      expect(() =>
        d.query(`select zstd_decompress(x'${hex}', 1) as out`).get(),
      ).toThrow(/Unknown frame descriptor/);
    }
    for (const hex of ["", "28b52ffd"]) {
      const row = d.query(`select zstd_decompress(x'${hex}', 1) as out`).get();
      expect(row.out).toBe("");
    }
    d.close();
  });

  test("unknown dict id throws a clear error", () => {
    const d = db();
    expect(() => d.query("select zstd_decompress(zstd_compress('abc', 3), 1, 999)").get()).toThrow(
      /load dict/,
    );
    d.close();
  });
});
