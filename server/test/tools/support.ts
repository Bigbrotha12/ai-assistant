import Database from "better-sqlite3";
import type {
  ToolBodies,
  ToolBody,
  ToolCall,
  ToolInterceptor,
} from "../../src/tools/pipeline.ts";
import { Ledger, migrateLedger } from "../../src/ledger.ts";

/** A complete `ToolCall` with plugin/sync defaults; override per test. */
export function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    source: "plugin",
    pluginId: "vikunja",
    pluginVersion: "1.4.0",
    tool: "list_tasks",
    args: {},
    readOnly: true,
    channel: "sync-stateless",
    actionId: "action-1",
    timeoutMs: 60_000,
    maxResultChars: 65_536,
    ...overrides,
  };
}

/** Bodies for both sources; the unexercised one returns "". */
export function makeBodies(overrides: Partial<ToolBodies> = {}): ToolBodies {
  const noop: ToolBody = async () => "";
  return { plugin: noop, mcp: noop, ...overrides };
}

/** An interceptor that records its own entry/exit around `next()`. */
export function tracingInterceptor(
  name: string,
  log: string[],
): ToolInterceptor {
  return {
    name,
    async around(_dispatch, next) {
      log.push(name);
      await next();
      log.push(`${name}:after`);
    },
  };
}

/** A migrated in-memory ledger for job-channel interceptor tests. */
export function makeLedger(): Ledger {
  const db = new Database(":memory:");
  migrateLedger(db);
  return new Ledger(db, { stuckTimeoutMs: 10_000, leaseExpiryMs: 60_000 });
}

/** A claimed running task plus its fence token, for job-channel tests. */
export function makeRunningTask(
  ledger: Ledger,
  owner = "user-1",
): { taskId: string; fenceToken: string } {
  const task = ledger.createTask({
    owner,
    intentKey: `k-${Math.random()}`,
    spec: "{}",
  });
  const claimed = ledger.claimTask(task.id, owner);
  return { taskId: task.id, fenceToken: claimed.fence_token };
}
