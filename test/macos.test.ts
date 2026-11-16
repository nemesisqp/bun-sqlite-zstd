// macOS setup contract. On Linux/macOS CI this runs on Linux, where
// setupSQLite() must be a harmless no-op returning false. The real macOS
// path (Homebrew SQLite + setCustomSQLite) is exercised in CI on
// macos-latest, where `brew install sqlite` runs first.
import { describe, test, expect } from "bun:test";
import { setupSQLite, openDatabase } from "../index.js";

describe("setupSQLite", () => {
  test("is a no-op returning false off macOS", () => {
    if (process.platform === "darwin") {
      // On macOS without Homebrew SQLite it returns false; with it, true.
      // Either way it must not throw.
      expect(typeof setupSQLite()).toBe("boolean");
    } else {
      expect(setupSQLite()).toBe(false);
    }
  });

  test("openDatabase works without any setup off macOS", () => {
    const db = openDatabase(":memory:") as any;
    const row = db.query("select zstd_decompress(zstd_compress('hello', 9), 1) as out").get();
    expect(row.out).toBe("hello");
    db.close();
  });
});
