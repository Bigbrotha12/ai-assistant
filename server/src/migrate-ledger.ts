import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { env } from "./env.ts";
import { CURRENT_LEDGER_VERSION, migrateLedger } from "./ledger.ts";

mkdirSync(dirname(env.LEDGER_DB_PATH), { recursive: true });
const db = new Database(env.LEDGER_DB_PATH);
const before = db.pragma("user_version", { simple: true }) as number;
migrateLedger(db);
const after = db.pragma("user_version", { simple: true }) as number;
db.close();
console.log(
  `ledger: migrated ${env.LEDGER_DB_PATH} ${before} -> ${after} ` +
    `(current ${CURRENT_LEDGER_VERSION})`,
);
