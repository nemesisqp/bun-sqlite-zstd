// Loader / platform resolution tests. These run without a Database —
// they only resolve the extension binary file on disk.
import { describe, test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import {
  getExtensionPath,
  loadExtension,
  openDatabase,
  SUPPORTED_TARGETS,
} from "../index.js";
import { candidateTriples, isMusl } from "../lib/loader.js";

const savedEnv = process.env.BUN_SQLITE_ZSTD_PATH;
afterEach(() => {
  if (savedEnv === undefined) delete process.env.BUN_SQLITE_ZSTD_PATH;
  else process.env.BUN_SQLITE_ZSTD_PATH = savedEnv;
});

describe("candidateTriples", () => {
  test("first candidate matches this machine", () => {
    const [first] = candidateTriples();
    if (process.platform === "linux") {
      expect(first).toBe(`linux-${process.arch}-${isMusl() ? "musl" : "gnu"}`);
    } else if (process.platform === "darwin") {
      expect(first).toBe(`darwin-${process.arch}`);
    } else if (process.platform === "win32") {
      expect(first).toBe(`win32-${process.arch}-msvc`);
    }
  });

  test("all 7 supported targets are known", () => {
    expect([...SUPPORTED_TARGETS].sort()).toEqual(
      [
        "darwin-arm64",
        "linux-x64-gnu",
        "linux-x64-musl",
        "linux-arm64-gnu",
        "linux-arm64-musl",
        "win32-x64-msvc",
        "win32-arm64-msvc",
      ].sort(),
    );
  });
});

describe("getExtensionPath", () => {
  test("resolves to an existing binary for this machine", () => {
    const p = getExtensionPath();
    expect(existsSync(p)).toBe(true);
    if (process.platform === "linux") expect(p.endsWith("libsqlite_zstd.so")).toBe(true);
    if (process.platform === "darwin") expect(p.endsWith("libsqlite_zstd.dylib")).toBe(true);
    if (process.platform === "win32") expect(p.endsWith("sqlite_zstd.dll")).toBe(true);
  });

  test("BUN_SQLITE_ZSTD_PATH override is honoured", () => {
    const real = getExtensionPath();
    process.env.BUN_SQLITE_ZSTD_PATH = real;
    expect(getExtensionPath()).toBe(real);
  });

  test("BUN_SQLITE_ZSTD_PATH to a missing file throws a clear error", () => {
    process.env.BUN_SQLITE_ZSTD_PATH = "/nonexistent/libsqlite_zstd.so";
    expect(() => getExtensionPath()).toThrow("/nonexistent/libsqlite_zstd.so");
  });
});

describe("loadExtension argument checking", () => {
  test("rejects a non-Database with a clear message", () => {
    expect(() => loadExtension({} as never)).toThrow("bun:sqlite Database");
    expect(() => loadExtension(null as never)).toThrow("bun:sqlite Database");
  });

  test("openDatabase loads the extension (zstd functions exist)", () => {
    const db = openDatabase(":memory:") as any;
    const row = db.query("select zstd_compress('hello', 3) as c").get();
    expect(row.c).toBeInstanceOf(Uint8Array);
    expect(row.c.length).toBeGreaterThan(0);
    db.close();
  });
});
