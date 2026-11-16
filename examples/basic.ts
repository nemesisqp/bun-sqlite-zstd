// Basic usage. Run with `bun examples/basic.ts`.
import { openDatabase, getExtensionPath } from "../index.js";

console.log("extension:", getExtensionPath());

const db = openDatabase(":memory:") as any;

// Plain compress / decompress.
const text = "the quick brown fox jumps over the lazy dog. ".repeat(200);
const compressed = db.query("select zstd_compress(?, 9) as c").get(text).c;
console.log("compressed", text.length, "bytes ->", compressed.length, "bytes");
console.log("roundtrip ok:", db.query("select zstd_decompress(?, 1) as out").get(compressed).out === text);

// With a trained dictionary, passed as a blob (cached by content).
db.exec("create table docs(id integer primary key, body text);");
{
  const ins = db.prepare("insert into docs(body) values (?)");
  db.exec("BEGIN");
  for (let i = 0; i < 200; i++) ins.run(`log ${i}: user edited src/lib/voice.ts (${"abc ".repeat(20)})`);
  db.exec("COMMIT");
}
const dict = db.query("select zstd_train_dict(body, 8192, 100) as d from docs").get().d;
const sample = db.query("select body from docs limit 1").get().body;
const withDict = db.query("select zstd_compress(?, 9, ?) as c").get(sample, dict).c;
console.log("with dict:", sample.length, "bytes ->", withDict.length, "bytes");
console.log(
  "dict roundtrip ok:",
  db.query("select zstd_decompress(?, 1, ?) as out").get(withDict, dict).out === sample,
);

db.close();
