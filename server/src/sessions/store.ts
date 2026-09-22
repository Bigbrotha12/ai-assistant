/**
 * Stateless-gateway session store (plan §4, D2/D3).
 *
 * The gateway's in-memory, evictable mirror of a client-owned conversation.
 * Sessions are keyed by `(owner, sessionId)` where `sessionId` is a
 * client-generated UUID, and hold an accumulated `messages[]` plus an
 * exactly-once anchor: `outcomes: Map<messageId, { status, reply? }>`.
 *
 * Deliberately RAM-only: no encryption, no durability, no disk. Eviction is the
 * recovery path — the client re-establishes under the SAME `session_id` and the
 * server answers `session_missing` with a reason (`"evicted"` | `"restart"`).
 *
 * CONCURRENCY (§4): sync turns on one session are serialized by a per-session
 * `AsyncMutex` (reuses `src/jobs/mutex.ts`). The mutex is held ONLY for the
 * short critical section (dedupe check → append → outcome recording, or the
 * outcome write); the graph run happens after the lock is released. The mutex
 * is keyed by the compound `(owner, sessionId)` key (not bare sessionId) so two
 * owners can never share a serialization domain.
 *
 * EVICTION:
 *   - idle TTL (default 24 h), swept by an unref'd periodic timer (mirrors
 *     `src/middleware/cache.ts`; injectable `now`/timers for tests);
 *   - per-owner active-session cap (default 32), evicts that owner's LRU;
 *   - global cap (default 1000) with OWNER-AWARE LRU: evict the requesting
 *     owner's own least-recently-used sessions first, only touching other
 *     owners' sessions when the requesting owner has none (R10);
 *   - per-session byte cap (default `CONTEXT_TOKEN_LIMIT × 4` = 131072) that
 *     counts text chars (~1 byte/char) PLUS the raw byte length of inline
 *     base64 image content; over-cap sessions are evicted. The sync path
 *     (step 2) additionally rejects establishes over the cap — here we only
 *     enforce eviction/measurement and expose `sessionBytes()`.
 *
 *   Evicted sessions leave a bounded tombstone so a later delta can distinguish
 *   `reason: "evicted"` (this process dropped it) from `"restart"` (never seen
 *   in this process). Explicit `deleteSession` leaves NO tombstone.
 *
 * BYTE COUNTING (D7 backstop): `estimateSessionBytes` sums text content
 * characters 1:1 (chars ≈ bytes) and adds `image_url.url.length` for image
 * blocks (base64 data URIs are ASCII, chars ≈ bytes). This reproduces the
 * plan's "≈ CONTEXT_TOKEN_LIMIT × 4 for text" budget: a session whose text
 * exceeds the token limit measures above the cap and is evicted, and images
 * push it over faster. Non-text/non-image blocks fall back to serialized JSON
 * length; `name` and AIMessage `tool_calls` are counted as text.
 *
 * OUTCOMES PRUNING: outcomes are capped at `maxOutcomesPerSession` (default
 * 64), pruning strictly-oldest entries by insertion order (the messageId
 * arrival order). We deliberately do NOT prune the corresponding `messages[]`
 * entries — the messages array is bounded by the byte cap and the client is
 * authoritative on history (documented choice per step-1 scope).
 *
 * ORPHANED `in_progress` OUTCOMES (N9): a turn in flight against one
 * incarnation cannot be finalized after a re-seed — `establish`/`reestablish`
 * bump the generation, and F4 makes the stale turn's `markFailed`/
 * `markCompleted` no-ops. Without intervention that outcome would sit
 * `in_progress` forever, wedging a same-messageId retry into a permanent 409
 * `conversation_in_flight`. Every re-seed therefore downgrades the previous
 * incarnation's `in_progress` outcomes to `failed` (the plan §4 step 6 clean
 * re-run anchor) — the orphaned append is already gone (messages were
 * replaced), so no rollback is needed. Genuinely-running turns are never
 * touched: a plain delta does not bump the generation, so its `in_progress`
 * outcome survives re-seed-free turns untouched. The residual after this —
 * an `in_progress` outcome for a turn whose process genuinely hangs mid-stream
 * with no re-seed — is accepted: the stream owns it, eviction clears it, and
 * age-based pruning was deliberately NOT chosen because it would let a
 * same-messageId retry double-execute a long-running turn.
 *
 * RETRY-ON-FAILED (plan §4 step 6): a `failed` outcome is NOT terminal for
 * dedupe. Re-sending the SAME messageId is a clean re-run — `appendDelta`
 * re-appends the user message, resets the outcome to `in_progress` (dropping
 * the failed flags), and returns `resumed` exactly as on a fresh delta. We
 * deliberately reuse the `resumed` status (rather than minting a `retried`
 * one): a retry-after-failure is indistinguishable from a normal delta append
 * on a live session, so the HTTP layer streams it as a normal `resumed` turn
 * with no extra wiring. A `completed` outcome still dedupes to
 * `already_completed`; an `in_progress` outcome still answers `in_progress`.
 * The client may therefore retry a failed turn with the same messageId
 * (idempotent sends only, §10) or mint a new one.
 *
 * EVICTED-MID-TURN: `markCompleted`/`markFailed` return `{ evicted: true }`
 * when the session was dropped while its turn ran (the session's mutex may be
 * orphaned but is reaped lazily when idle). Eviction itself never waits on a
 * session mutex — RAM is volatile by design (§10).
 *
 * INCARNATION/GENERATION (F4): `SessionRecord.generation` is bumped on EVERY
 * `establish` (seed AND re-seed — the §6 compaction re-base is an establish).
 * A turn captures the generation at append time; `markCompleted`/`markFailed`
 * (and an `appendDelta` called with `expectedGeneration`) no-op when the
 * session's generation has since changed — an evicted-then-reseeded session
 * must never be stamped by the stale turn or receive its stale reply.
 *
 * REPLY APPENDS (F5): the assistant-reply append at turn finalization is a
 * NON-USER append. `appendDelta` with `evictOnOverflow: false` drops an
 * over-cap reply (returns `resumed` without storing it) instead of evicting the
 * whole session — the client cannot control reply size.
 */
import { AsyncMutex } from "../jobs/mutex.ts";
import { isRecord } from "../util.ts";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export type SessionKey = { owner: string; sessionId: string };

/**
 * Stored outcome: terminal states plus the transient `in_progress` that carries
 * a reference to the appended user message so `markFailed` can roll it back.
 */
export type SessionOutcomeState =
  | { status: "in_progress"; message: BaseMessage }
  | { status: "completed"; reply?: BaseMessage }
  | { status: "failed" };

export type SessionRecord = {
  messages: BaseMessage[];
  outcomes: Map<string, SessionOutcomeState>;
  createdAt: number;
  lastTouchedAt: number;
  /** Incarnation token, bumped on every `establish` (F4). */
  generation: number;
};

export type SessionMissingReason = "evicted" | "restart";

/**
 * What a sync turn's write resolved to. `session_missing` is the signal for
 * step 2 to emit `409 { error: "session_missing", reason }`; the client then
 * re-establishes under the SAME session_id (§5).
 */
export type EstablishResult =
  | { status: "established"; generation: number }
  | { status: "session_missing"; reason: SessionMissingReason };

export type AppendDeltaResult =
  | { status: "resumed"; generation: number }
  | { status: "already_completed"; reply?: BaseMessage }
  | { status: "in_progress" }
  | { status: "generation_changed" } // F4: expectedGeneration append on a re-seeded session
  | { status: "session_missing"; reason: SessionMissingReason };

/**
 * Atomic re-establish of a LIVE session (§6 compaction re-base / F2): dedupe-
 * checks `messageId` under the same mutex hold as the message replacement, so a
 * retransmitted body (already_completed / in_progress) short-circuits WITHOUT
 * replacing the session.
 */
export type ReestablishResult =
  | { status: "reestablished"; generation: number }
  | { status: "already_completed"; reply?: BaseMessage }
  | { status: "in_progress" }
  | { status: "session_missing"; reason: SessionMissingReason };

export type SessionLookupResult = EstablishResult | AppendDeltaResult;

/** `markCompleted`/`markFailed`: true when the session was evicted mid-turn. */
export type SessionMutationResult = { evicted: boolean };

export type SessionStoreOptions = {
  /** Idle TTL; sessions untouched for this long are evicted. Default 24 h. */
  idleTtlMs?: number;
  /** Per-owner active-session cap. Default 32. */
  maxSessionsPerOwner?: number;
  /** Global session cap with owner-aware LRU eviction. Default 1000. */
  maxSessions?: number;
  /** Per-session byte cap; over-cap sessions are evicted. Default 131072
   *  (`CONTEXT_TOKEN_LIMIT` default 32768 × 4 chars/token). */
  maxSessionBytes?: number;
  /** `outcomes` per session; strictly-oldest pruned past this. Default 64. */
  maxOutcomesPerSession?: number;
  /** Bound on retained eviction tombstones. Default = maxSessions. */
  maxTombstones?: number;
  /** Periodic sweep interval; defaults to `idleTtlMs`. */
  sweepIntervalMs?: number;
  /** Injectable monotonic clock; defaults to Date.now. */
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

export const DEFAULT_SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS_PER_OWNER = 32;
export const DEFAULT_MAX_SESSIONS = 1000;
export const DEFAULT_MAX_SESSION_BYTES = 32_768 * 4;
export const DEFAULT_MAX_OUTCOMES_PER_SESSION = 64;

export type SessionStore = {
  /**
   * Seed/re-seed a session's messages (first turn, client reseed, or client
   * compaction re-base). Replaces `messages`; on a re-establish of a LIVE
   * session the `outcomes` map is preserved (it is the exactly-once anchor) and
   * `generation` is bumped (F4 — a stale in-flight turn cannot stamp the new
   * incarnation). Returns `established` + the new generation, or
   * `session_missing` when the seed exceeds the byte cap (evicted) — the client
   * must trim and re-seed.
   */
  establish(
    owner: string,
    sessionId: string,
    messages: BaseMessage[],
  ): Promise<EstablishResult>;
  /**
   * Exactly-once delta (§4 steps 1–3): atomic under the per-session mutex.
   * `resumed` on first sight AND on a retry of a `failed` messageId (a clean
   * re-run per §4 step 6 — the message is re-appended and the outcome reset to
   * in_progress); `already_completed`/`in_progress` on a duplicate messageId;
   * `session_missing` when the session is gone.
   *
   * `opts.expectedGeneration` (F4): when provided and the session's generation
   * has moved on (re-seeded), returns `generation_changed` without appending —
   * used by the assistant-reply append so a stale turn cannot write into a new
   * incarnation. `opts.evictOnOverflow === false` (F5): an over-cap append
   * DROPS the message instead of evicting the session (the assistant-reply
   * path — the client cannot control reply size); the session survives with
   * `lastTouchedAt` bumped and the outcome stays `in_progress`.
   */
  appendDelta(
    owner: string,
    sessionId: string,
    messageId: string,
    message: BaseMessage,
    opts?: { expectedGeneration?: number; evictOnOverflow?: boolean },
  ): Promise<AppendDeltaResult>;
  /**
   * Atomic re-establish of a LIVE session (F2/§6 compaction re-base). Under the
   * per-session mutex: dedupe-check `messageId` FIRST (a completed/in-flight
   * duplicate short-circuits WITHOUT replacing messages — a retransmitted body
   * is not a re-base and must not clobber the session), then REPLACE `messages`
   * with the given full history (the last message — the trailing user turn — is
   * seeded via the exactly-once `outcomes[messageId]` anchor), bumping
   * `generation`. The session must already exist (`session_missing` otherwise).
   */
  reestablish(
    owner: string,
    sessionId: string,
    messageId: string,
    messages: BaseMessage[],
  ): Promise<ReestablishResult>;
  /**
   * Record a successful outcome. `{ evicted: true }` if evicted mid-turn. When
   * `generation` is provided and the session's generation has since changed
   * (re-seeded mid-turn), the write is a no-op (F4) and returns `{ evicted:
   * false }` — the stale turn must not stamp the new incarnation.
   */
  markCompleted(
    owner: string,
    sessionId: string,
    messageId: string,
    reply: BaseMessage,
    generation?: number,
  ): Promise<SessionMutationResult>;
  /**
   * Record a failure AND roll back the appended user message (§4 step 6).
   * `{ evicted: true }` if evicted mid-turn (nothing to roll back). When
   * `generation` is provided and the session's generation has since changed
   * (re-seeded mid-turn), the write is a no-op (F4) — nothing to roll back in
   * the new incarnation.
   */
  markFailed(
    owner: string,
    sessionId: string,
    messageId: string,
    generation?: number,
  ): Promise<SessionMutationResult>;
  /** Live record reference (touches `lastTouchedAt`), or null. */
  get(owner: string, sessionId: string): SessionRecord | null;
  /** Copy of the session's messages (touches `lastTouchedAt`), or null. */
  getMessages(owner: string, sessionId: string): BaseMessage[] | null;
  /**
   * Owner of a LIVE session keyed by sessionId, or null when no live session
   * carries it (read-back / ownership probe; never returns message content).
   * Lets `GET /v1/sessions/:id` distinguish a cross-owner id (404) from an
   * absent one (409 session_missing) without leaking the messages themselves.
   */
  lookupOwner(sessionId: string): string | null;
  /**
   * Miss classification for the CALLER's own key: null when the session is
   * live, otherwise `"evicted"` (a tombstone exists for this key) or
   * `"restart"` (never seen in this process). A cross-owner session is
   * indistinguishable from `"restart"` here — the read-back route resolves
   * that with `lookupOwner`.
   */
  missingReason(owner: string, sessionId: string): SessionMissingReason | null;
  /** All of one owner's sessions' messages (read-back / diagnostics). */
  listMessages(owner: string): Array<{ sessionId: string; messages: BaseMessage[] }>;
  /** Bump `lastTouchedAt` (keeps a session alive across the TTL). */
  touch(owner: string, sessionId: string): void;
  /** Remove one session. Returns whether it existed. Leaves no tombstone. */
  deleteSession(owner: string, sessionId: string): boolean;
  /** Remove every session of an owner. Returns how many were removed. */
  deleteSessionsForOwner(owner: string): number;
  /** Byte estimate of a session or message list (see header note). */
  sessionBytes(input: SessionRecord | readonly BaseMessage[]): number;
  /** Session count, globally or for one owner. */
  count(owner?: string): number;
  /** Live global session count. */
  get size(): number;
  /** Stop the periodic sweep. Idempotent. */
  dispose(): void;
};

/** Internal Map key: \u0000-joined (owner, sessionId). */
function internalKey(owner: string, sessionId: string): string {
  if (owner.includes("\u0000") || sessionId.includes("\u0000")) {
    throw new Error("session key parts must not contain the NUL separator");
  }
  return `${owner}\u0000${sessionId}`;
}

function isMessageList(
  value: SessionRecord | readonly BaseMessage[],
): value is readonly BaseMessage[] {
  return Array.isArray(value);
}

/**
 * Byte estimate for one message: text content chars (≈ bytes) plus raw
 * `image_url.url` length (base64 data URI), with JSON fallbacks for other
 * content blocks. `name` and AIMessage `tool_calls` count as text.
 */
function estimateMessageBytes(message: BaseMessage): number {
  let total = 0;
  const content = message.content;
  if (typeof content === "string") {
    total += content.length;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) {
        total += JSON.stringify(block)?.length ?? 0;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        total += block.text.length;
      } else if (block.type === "image_url") {
        const url =
          isRecord(block.image_url) && typeof block.image_url.url === "string"
            ? block.image_url.url
            : undefined;
        total += url !== undefined ? url.length : JSON.stringify(block)?.length ?? 0;
      } else {
        total += JSON.stringify(block)?.length ?? 0;
      }
    }
  } else {
    total += JSON.stringify(content)?.length ?? 0;
  }
  if (message.name) total += message.name.length;
  if (message instanceof AIMessage && message.tool_calls?.length) {
    total += JSON.stringify(message.tool_calls).length;
  }
  return total;
}

/** Byte estimate of a session's message list (text chars + image bytes). */
export function estimateSessionBytes(messages: readonly BaseMessage[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageBytes(message);
  return total;
}

type StoredSession = { key: SessionKey; record: SessionRecord };

export function createSessionStore(
  opts: SessionStoreOptions = {},
): SessionStore {
  const idleTtlMs = opts.idleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const maxSessionsPerOwner = opts.maxSessionsPerOwner ?? DEFAULT_MAX_SESSIONS_PER_OWNER;
  const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxSessionBytes = opts.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const maxOutcomesPerSession =
    opts.maxOutcomesPerSession ?? DEFAULT_MAX_OUTCOMES_PER_SESSION;
  const maxTombstones = opts.maxTombstones ?? maxSessions;
  for (const [name, value] of [
    ["idleTtlMs", idleTtlMs],
    ["maxSessionsPerOwner", maxSessionsPerOwner],
    ["maxSessions", maxSessions],
    ["maxSessionBytes", maxSessionBytes],
    ["maxOutcomesPerSession", maxOutcomesPerSession],
    ["maxTombstones", maxTombstones],
  ] as const) {
    if (!(value > 0)) {
      throw new Error(`createSessionStore: ${name} must be a positive number, got ${value}`);
    }
  }

  const now = opts.now ?? Date.now;
  const sweepIntervalMs = opts.sweepIntervalMs ?? idleTtlMs;
  if (!(sweepIntervalMs > 0)) {
    throw new Error(
      `createSessionStore: sweepIntervalMs must be a positive number, got ${sweepIntervalMs}`,
    );
  }

  const sessions = new Map<string, StoredSession>();
  const mutexes = new Map<string, AsyncMutex>();
  // Bounded tombstone of evicted internal keys → lastTouchedAt of eviction.
  const tombstones = new Map<string, number>();
  let disposed = false;

  const pruneTombstones = (): void => {
    while (tombstones.size > maxTombstones) {
      const oldest = tombstones.keys().next().value;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
    }
  };

  /** Remove a session and mark it evicted (no-op if already gone). */
  const evictStored = (k: string): void => {
    const stored = sessions.get(k);
    if (!stored) return;
    sessions.delete(k);
    tombstones.set(k, now());
    pruneTombstones();
    maybeReapMutex(k);
  };

  const maybeReapMutex = (k: string): void => {
    const mutex = mutexes.get(k);
    if (mutex && mutex.isIdle) mutexes.delete(k);
  };

  const ensureMutex = (k: string): AsyncMutex => {
    let mutex = mutexes.get(k);
    if (!mutex) {
      mutex = new AsyncMutex();
      mutexes.set(k, mutex);
    }
    return mutex;
  };

  const pruneOutcomes = (record: SessionRecord): void => {
    while (record.outcomes.size > maxOutcomesPerSession) {
      const oldest = record.outcomes.keys().next().value;
      if (oldest === undefined) break;
      record.outcomes.delete(oldest);
    }
  };

  /**
   * N9: downgrade every `in_progress` outcome to `failed`. Called only on a
   * re-seed (which bumps the generation): a turn that was in flight against
   * the PREVIOUS incarnation can never be finalized by its own stream (F4 — a
   * mark against the bumped generation no-ops), so leaving it `in_progress`
   * would wedge a same-messageId retry into a permanent 409
   * `conversation_in_flight`. `failed` keeps the plan §4 step 6 retry contract
   * (a clean re-run). No message rollback is needed — the re-seed REPLACED
   * `messages`, so the orphaned append is already gone. Genuinely-running
   * turns are never touched: a normal delta does not bump the generation, so
   * this only ever fires on an actual re-seed.
   */
  const orphanInProgress = (record: SessionRecord): void => {
    for (const [messageId, outcome] of record.outcomes) {
      if (outcome.status === "in_progress") {
        record.outcomes.set(messageId, { status: "failed" });
      }
    }
  };

  const lruForOwner = (owner: string): string | null => {
    let lru: string | null = null;
    let oldest = Infinity;
    for (const [k, stored] of sessions) {
      if (stored.key.owner !== owner) continue;
      if (stored.record.lastTouchedAt < oldest) {
        oldest = stored.record.lastTouchedAt;
        lru = k;
      }
    }
    return lru;
  };

  const lruGlobal = (): string | null => {
    let lru: string | null = null;
    let oldest = Infinity;
    for (const [k, stored] of sessions) {
      if (stored.record.lastTouchedAt < oldest) {
        oldest = stored.record.lastTouchedAt;
        lru = k;
      }
    }
    return lru;
  };

  const sweep = (): void => {
    const t = now();
    for (const [k, stored] of sessions) {
      if (t - stored.record.lastTouchedAt >= idleTtlMs) evictStored(k);
    }
    // Reap orphaned idle mutexes (their session is gone) so the mutex map
    // stays bounded without blocking any in-flight turn.
    for (const [k, mutex] of mutexes) {
      if (mutex.isIdle && !sessions.has(k)) mutexes.delete(k);
    }
  };

  const setInterval = opts.setInterval ?? globalThis.setInterval.bind(globalThis);
  const clearInterval =
    opts.clearInterval ?? globalThis.clearInterval.bind(globalThis);
  const sweepTimer = setInterval(() => {
    try {
      sweep();
    } catch (err) {
      console.warn("[sessions] sweep failed:", err);
    }
  }, sweepIntervalMs);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();

  return {
    async establish(owner, sessionId, messages) {
      const k = internalKey(owner, sessionId);
      const release = await ensureMutex(k).acquire();
      try {
        const existing = sessions.get(k);
        const t = now();
        const record: SessionRecord = {
          messages: [...messages],
          outcomes: existing ? existing.record.outcomes : new Map(),
          createdAt: existing ? existing.record.createdAt : t,
          lastTouchedAt: t,
          // Every establish — seed AND re-seed (§6 compaction re-base) — mints
          // a new incarnation so a mid-turn eviction+re-establish cannot be
          // stamped by the stale turn (F4).
          generation: (existing?.record.generation ?? 0) + 1,
        };
        // Size-aware eviction: an over-cap seed (or re-seed) cannot be held.
        if (estimateSessionBytes(record.messages) > maxSessionBytes) {
          evictStored(k);
          return { status: "session_missing", reason: "evicted" };
        }
        if (!existing) {
          // Owner-aware global cap: prefer evicting the requesting owner's own
          // LRU sessions; fall back to the globally LRU session (R10).
          while (sessions.size >= maxSessions) {
            const victim = lruForOwner(owner) ?? lruGlobal();
            if (!victim) break;
            evictStored(victim);
          }
          let ownerCount = 0;
          for (const [, stored] of sessions) {
            if (stored.key.owner === owner) ownerCount += 1;
          }
          while (ownerCount >= maxSessionsPerOwner) {
            const victim = lruForOwner(owner);
            if (!victim) break;
            evictStored(victim);
            ownerCount -= 1;
          }
        }
        // N9: a re-seed orphans every in-flight turn of the previous
        // incarnation (its finalization no-ops under F4), so downgrade those
        // outcomes to `failed` instead of leaving them `in_progress` forever.
        if (existing) orphanInProgress(record);
        sessions.set(k, { key: { owner, sessionId }, record });
        return { status: "established", generation: record.generation };
      } finally {
        release();
      }
    },

    async reestablish(owner, sessionId, messageId, messages) {
      const k = internalKey(owner, sessionId);
      const release = await ensureMutex(k).acquire();
      try {
        const existing = sessions.get(k);
        if (!existing) {
          return {
            status: "session_missing",
            reason: tombstones.has(k) ? "evicted" : "restart",
          };
        }
        const record = existing.record;
        // Dedupe FIRST (F2): a retransmitted body whose messageId is already
        // completed/in-flight is NOT a compaction re-base — short-circuit
        // without touching the session's messages.
        const existingOutcome = record.outcomes.get(messageId);
        if (existingOutcome) {
          if (existingOutcome.status === "completed") {
            return { status: "already_completed", reply: existingOutcome.reply };
          }
          if (existingOutcome.status !== "failed") {
            return { status: "in_progress" };
          }
          // failed → clean re-run: fall through and re-base + re-anchor.
        }
        // The caller guarantees the last message is the trailing user turn
        // (validated at the transport). Seed WITHOUT it, then append it as the
        // exactly-once anchor — mirrors the missing-session establish flow so a
        // failed re-base rolls back cleanly (no duplicate on retry).
        const history = messages.length > 0 ? messages.slice(0, -1) : [];
        const lastUser = messages[messages.length - 1];
        const t = now();
        const next: SessionRecord = {
          messages: [...history],
          outcomes: record.outcomes,
          createdAt: record.createdAt,
          lastTouchedAt: t,
          generation: record.generation + 1,
        };
        // N9: the generation bump orphans every in-flight turn of the previous
        // incarnation (its finalization no-ops under F4); downgrade those
        // outcomes to `failed` so a same-messageId retry is a clean re-run
        // rather than a permanent 409. The re-base's own messageId is NOT
        // in_progress here (the dedupe check above short-circuited), so it is
        // untouched by the downgrade.
        orphanInProgress(next);
        if (lastUser) {
          next.messages.push(lastUser);
          next.outcomes.set(messageId, { status: "in_progress", message: lastUser });
          pruneOutcomes(next);
        }
        if (estimateSessionBytes(next.messages) > maxSessionBytes) {
          evictStored(k);
          return { status: "session_missing", reason: "evicted" };
        }
        sessions.set(k, { key: existing.key, record: next });
        return { status: "reestablished", generation: next.generation };
      } finally {
        release();
      }
    },

    async appendDelta(owner, sessionId, messageId, message, opts) {
      const k = internalKey(owner, sessionId);
      const release = await ensureMutex(k).acquire();
      try {
        const stored = sessions.get(k);
        if (!stored) {
          return {
            status: "session_missing",
            reason: tombstones.has(k) ? "evicted" : "restart",
          };
        }
        const record = stored.record;
        // Generation guard (F4): a caller holding a generation captured earlier
        // (the assistant-reply append at turn finalization) must not append
        // into a session that was re-seeded since. Checked before any mutation.
        if (
          opts?.expectedGeneration !== undefined &&
          record.generation !== opts.expectedGeneration
        ) {
          return { status: "generation_changed" };
        }
        const existingOutcome = record.outcomes.get(messageId);
        if (existingOutcome) {
          if (existingOutcome.status === "completed") {
            return { status: "already_completed", reply: existingOutcome.reply };
          }
          if (existingOutcome.status !== "failed") {
            return { status: "in_progress" };
          }
          // A `failed` outcome is a clean re-run (plan §4 step 6): fall
          // through to re-append the user message and reset the outcome to
          // in_progress (markFailed already rolled the previous append back).
        }
        record.messages.push(message);
        record.outcomes.set(messageId, { status: "in_progress", message });
        record.lastTouchedAt = now();
        pruneOutcomes(record);
        if (estimateSessionBytes(record.messages) > maxSessionBytes) {
          if (opts?.evictOnOverflow === false) {
            // Non-user (assistant-reply) append (F5): the client cannot control
            // reply size, so an over-cap reply is DROPPED rather than evicting
            // the session. The session survives (lastTouchedAt already bumped)
            // and the messageId outcome stays in_progress so markCompleted can
            // still complete it — the reply is simply absent from the read-back
            // (the client re-establishes with full history if it needs it).
            record.messages.pop();
            return { status: "resumed", generation: record.generation };
          }
          evictStored(k);
          return { status: "session_missing", reason: "evicted" };
        }
        return { status: "resumed", generation: record.generation };
      } finally {
        release();
      }
    },

    async markCompleted(owner, sessionId, messageId, reply, generation) {
      const k = internalKey(owner, sessionId);
      const release = await ensureMutex(k).acquire();
      try {
        const stored = sessions.get(k);
        if (!stored) return { evicted: true };
        if (generation !== undefined && stored.record.generation !== generation) {
          // The session was re-seeded since this turn's append: a stale
          // finalization must not stamp the new incarnation (F4).
          return { evicted: false };
        }
        stored.record.outcomes.set(messageId, { status: "completed", reply });
        return { evicted: false };
      } finally {
        release();
      }
    },

    async markFailed(owner, sessionId, messageId, generation) {
      const k = internalKey(owner, sessionId);
      const release = await ensureMutex(k).acquire();
      try {
        const stored = sessions.get(k);
        if (!stored) return { evicted: true };
        if (generation !== undefined && stored.record.generation !== generation) {
          // Stale finalization after a re-seed: nothing to roll back in the new
          // incarnation (F4).
          return { evicted: false };
        }
        const record = stored.record;
        const outcome = record.outcomes.get(messageId);
        // Never downgrade an already-completed outcome.
        if (outcome?.status === "completed") return { evicted: false };
        if (outcome?.status === "in_progress") {
          const idx = record.messages.indexOf(outcome.message);
          if (idx >= 0) record.messages.splice(idx, 1);
        }
        record.outcomes.set(messageId, { status: "failed" });
        return { evicted: false };
      } finally {
        release();
      }
    },

    get(owner, sessionId) {
      const stored = sessions.get(internalKey(owner, sessionId));
      if (!stored) return null;
      stored.record.lastTouchedAt = now();
      return stored.record;
    },

    getMessages(owner, sessionId) {
      const stored = sessions.get(internalKey(owner, sessionId));
      if (!stored) return null;
      stored.record.lastTouchedAt = now();
      return [...stored.record.messages];
    },

    lookupOwner(sessionId) {
      for (const [, stored] of sessions) {
        if (stored.key.sessionId === sessionId) return stored.key.owner;
      }
      return null;
    },

    missingReason(owner, sessionId) {
      const k = internalKey(owner, sessionId);
      if (sessions.has(k)) return null;
      return tombstones.has(k) ? "evicted" : "restart";
    },

    listMessages(owner) {
      const out: Array<{ sessionId: string; messages: BaseMessage[] }> = [];
      for (const [, stored] of sessions) {
        if (stored.key.owner !== owner) continue;
        out.push({
          sessionId: stored.key.sessionId,
          messages: [...stored.record.messages],
        });
      }
      return out;
    },

    touch(owner, sessionId) {
      const stored = sessions.get(internalKey(owner, sessionId));
      if (stored) stored.record.lastTouchedAt = now();
    },

    deleteSession(owner, sessionId) {
      const k = internalKey(owner, sessionId);
      const existed = sessions.delete(k);
      maybeReapMutex(k);
      return existed;
    },

    deleteSessionsForOwner(owner) {
      let removed = 0;
      for (const [k, stored] of sessions) {
        if (stored.key.owner !== owner) continue;
        sessions.delete(k);
        maybeReapMutex(k);
        removed += 1;
      }
      return removed;
    },

    sessionBytes(input) {
      const messages = isMessageList(input) ? input : input.messages;
      return estimateSessionBytes(messages);
    },

    count(owner) {
      if (owner === undefined) return sessions.size;
      let n = 0;
      for (const [, stored] of sessions) {
        if (stored.key.owner === owner) n += 1;
      }
      return n;
    },

    get size() {
      return sessions.size;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(sweepTimer);
    },
  };
}