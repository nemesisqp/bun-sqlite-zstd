// Compile-time check of the public API surface (index.d.ts).
// Run with `npm run typecheck`. Bun types are intentionally not required:
// openDatabase() returns the minimal SQLiteDatabase surface below.
import {
  setupSQLite,
  getExtensionPath,
  loadExtension,
  openDatabase,
  SUPPORTED_TARGETS,
  type SQLiteDatabase,
} from "../index.js";

const isMacSetup: boolean = setupSQLite();
const extPath: string = getExtensionPath();
const targets: string[] = SUPPORTED_TARGETS;

declare const db: SQLiteDatabase;
const loaded: SQLiteDatabase = loadExtension(db);
const loadedWithPath: SQLiteDatabase = loadExtension(db, {
  extensionPath: "/tmp/libsqlite_zstd.so",
});
const opened: SQLiteDatabase = openDatabase(":memory:");
const openedFile: SQLiteDatabase = openDatabase("/tmp/test.db", {
  extensionPath: "/tmp/libsqlite_zstd.so",
  sqliteOptions: { readonly: false },
});

void [isMacSetup, extPath, targets, loaded, loadedWithPath, opened, openedFile];
