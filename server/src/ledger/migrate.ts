import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { env } from "../config/env.ts";
import { CURRENT_LEDGER_VERSION, migrateLedger } from "./index.ts";
import { configureLedgerConnection, hardenLedgerFiles } from "./schema.ts";

mkdirSync(dirname(env.LEDGER_DB_PATH), { recursive: true });
const db = new Database(env.LEDGER_DB_PATH);
configureLedgerConnection(db);
const before = db.pragma("user_version", { simple: true }) as number;
migrateLedger(db);
// Harden the file and its WAL/SHM sidecars before close; a clean close removes
// the sidecars, so chmod after migrate must happen while the connection is open.
hardenLedgerFiles(env.LEDGER_DB_PATH);
const after = db.pragma("user_version", { simple: true }) as number;
db.close();
console.log(
  `ledger: migrated ${env.LEDGER_DB_PATH} ${before} -> ${after} ` +
    `(current ${CURRENT_LEDGER_VERSION})`,
);
