import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../util.ts";

/**
 * Encrypted-at-rest store for per-owner ntfy push credentials (plan §
 * Notifications: the topic + access token are a secret, stored encrypted
 * server-side, provisioned via an authenticated endpoint).
 *
 * SECURITY CONTRACT
 *  - **Both the topic and the access token are secrets.** Each owner's record
 *    is serialized (`{ topic, accessToken }`) and encrypted as a single
 *    AES-256-GCM payload before it is written to disk. The topic alone is
 *    benign (it is returned to the owner on later reads), but pairing it with
 *    the token makes the record a publish/subscribe credential, so the whole
 *    record is stored encrypted.
 *  - **Keying reuses the CHECKPOINT_DB_KEY pattern** (DI-friendly — no `env`
 *    import here): the caller injects the key string (production supplies it
 *    via `CHECKPOINT_DB_KEY`; development has the same warned default the env
 *    schema guarantees). The AES-256-GCM key is derived deterministically
 *    (`sha256(key)`) so previously-written files stay decryptable across
 *    restarts, mirroring how the checkpoints store keys its SQLCipher DB.
 *  - **0600 permissions + atomic write.** Persist writes the JSON to a temp
 *    file in the same directory, chmods it `0600`, then renames over the
 *    target (same as `plugins/store.ts`). A crash never leaves a partial file.
 *  - **Never logs key material.** Error messages carry paths and low-level
 *    crypto errors only — never the topic or the token.
 *  - **Schema versioned** like the ledger/plugin stores (`schemaVersion`);
 *    an unserializable or version-mismatched file refuses to load rather than
 *    silently operating on a hand-edited store.
 */

/** Where the notify store lives when no path is configured. */
export const DEFAULT_NOTIFY_STORE_PATH = "./data/notify.json";

export const CURRENT_NOTIFY_STORE_VERSION = 1;

/** AES-256-GCM ciphertext bundle persisted for one owner's credentials. */
export type NotifyCipherBundle = {
  iv: string;
  tag: string;
  data: string;
};

export type NotifyCredentials = {
  topic: string;
  accessToken: string;
};

type NotifyStoreFile = {
  schemaVersion: number;
  accounts: Record<string, { credentials: NotifyCipherBundle }>;
};

export type NotifyStoreErrorCode = "KEY_REQUIRED" | "DECRYPT_FAILED" | "FILE_IO";

/** Raised by `NotifyStore` on configuration/IO/decryption failures. */
export class NotifyStoreError extends Error {
  readonly code: NotifyStoreErrorCode;

  constructor(code: NotifyStoreErrorCode, message: string) {
    super(message);
    this.name = "NotifyStoreError";
    this.code = code;
  }
}

export type NotifyStoreOptions = {
  /** JSON file path. Default `./data/notify.json`. */
  storePath?: string;
  /**
   * Encryption key — the CHECKPOINT_DB_KEY secret pattern. Required: the store
   * refuses to operate with a blank key (`KEY_REQUIRED`), matching
   * `createCheckpointStore`'s refusal to open an unencrypted DB.
   */
  key: string;
};

/** Derives the 32-byte AES-256-GCM key from the injected secret. */
function deriveAesKey(key: string): Buffer {
  return createHash("sha256").update(key, "utf8").digest();
}

export class NotifyStore {
  private readonly storePath: string;
  private readonly aesKey: Buffer;
  private file: NotifyStoreFile | null = null;

  constructor(opts: NotifyStoreOptions) {
    this.storePath = opts.storePath ?? DEFAULT_NOTIFY_STORE_PATH;
    if (!opts.key) {
      throw new NotifyStoreError(
        "KEY_REQUIRED",
        "NotifyStore: an encryption key is required — ntfy credentials are " +
          "encrypted at rest and the store refuses a blank key. Supply the " +
          "CHECKPOINT_DB_KEY secret (the env layer guarantees a dev default).",
      );
    }
    this.aesKey = deriveAesKey(opts.key);
  }

  /** Absolute/configured path of the store file. */
  get path(): string {
    return this.storePath;
  }

  /**
   * Reads an owner's DECRYPTED credentials, or `undefined` when the owner has
   * never been provisioned. Never logs the returned material.
   */
  async get(owner: string): Promise<NotifyCredentials | undefined> {
    await this.ensureLoaded();
    const account = this.file!.accounts[owner];
    return account ? this.decrypt(account.credentials) : undefined;
  }

  /** Encrypts and persists the owner's credentials (upsert). */
  async set(owner: string, credentials: NotifyCredentials): Promise<void> {
    await this.ensureLoaded();
    const next: NotifyStoreFile = {
      schemaVersion: CURRENT_NOTIFY_STORE_VERSION,
      accounts: {
        ...this.file!.accounts,
        [owner]: { credentials: this.encrypt(credentials) },
      },
    };
    await this.persist(next);
  }

  /** Deletes the owner's credentials. Returns whether a record was removed. */
  async delete(owner: string): Promise<boolean> {
    await this.ensureLoaded();
    if (!(owner in this.file!.accounts)) return false;
    const accounts = { ...this.file!.accounts };
    delete accounts[owner];
    await this.persist({ schemaVersion: CURRENT_NOTIFY_STORE_VERSION, accounts });
    return true;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.file !== null) return;
    let raw: string;
    try {
      raw = await readFile(this.storePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.file = { schemaVersion: CURRENT_NOTIFY_STORE_VERSION, accounts: {} };
        return;
      }
      throw new NotifyStoreError(
        "FILE_IO",
        `could not read notify store ${this.storePath}: ${String(err)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new NotifyStoreError(
        "FILE_IO",
        `notify store ${this.storePath} is not valid JSON: ${(err as Error).message}`,
      );
    }
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== CURRENT_NOTIFY_STORE_VERSION ||
      !isRecord(parsed.accounts)
    ) {
      throw new NotifyStoreError(
        "FILE_IO",
        `notify store ${this.storePath} has an unexpected shape or schema version; ` +
          "refusing to operate over a hand-edited file",
      );
    }
    this.file = parsed as NotifyStoreFile;
  }

  /** Atomic save: tmp file in the same dir, chmod 0600, rename over target. */
  private async persist(file: NotifyStoreFile): Promise<void> {
    const json = `${JSON.stringify(file, null, 2)}\n`;
    const tmpPath = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      await writeFile(tmpPath, json, { encoding: "utf8" });
      await chmod(tmpPath, 0o600);
      await rename(tmpPath, this.storePath);
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      throw new NotifyStoreError(
        "FILE_IO",
        `could not write notify store ${this.storePath}: ${String(err)}`,
      );
    }
    this.file = file;
  }

  private encrypt(credentials: NotifyCredentials): NotifyCipherBundle {
    const plaintext = JSON.stringify(credentials);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.aesKey, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: data.toString("hex"),
    };
  }

  private decrypt(bundle: NotifyCipherBundle): NotifyCredentials {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.aesKey,
        Buffer.from(bundle.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(bundle.tag, "hex"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(bundle.data, "hex")),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as NotifyCredentials;
    } catch (err) {
      // GCM authentication failure = wrong key or a tampered file. The error
      // text MUST NOT include the credentials themselves.
      throw new NotifyStoreError(
        "DECRYPT_FAILED",
        `could not decrypt an owner's notify credentials (wrong key or tampered file): ${String(err)}`,
      );
    }
  }
}