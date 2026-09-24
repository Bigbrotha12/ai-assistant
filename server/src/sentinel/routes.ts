import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import type { Context } from "hono";
import { accountDeletedResponse, keyGateResponse, requireApiKey } from "../api_key.ts";
import type { KeyAuth } from "../api_key.ts";
import { isDeleting } from "../account_deletion.ts";
import { createPerOwnerRateLimiter } from "../middleware/rate_limit.ts";
import type { PerOwnerRateLimiter, RateLimitResult } from "../middleware/rate_limit.ts";
import { isRecord } from "../util.ts";
import { SentinelService, SentinelTaskNotFoundError } from "./service.ts";
import { policyForMode } from "./policy.ts";
import type { SentinelCategory, SentinelCheckRequest, SentinelDirection, SentinelPolicyMode } from "./types.ts";
import { SENTINEL_CATEGORIES, SENTINEL_DIRECTIONS } from "./types.ts";
import type { Ledger } from "../ledger.ts";

export const DEFAULT_SENTINEL_MAX_BODY_BYTES = 65_536;

export type SentinelVerifyKey = (c: Context) => Promise<KeyAuth>;
export type SentinelRateLimiter =
  | PerOwnerRateLimiter
  | ((owner: string) => boolean);

export type SentinelRoutesOptions = {
  ledger: Ledger;
  service?: SentinelService;
  verifyKey?: SentinelVerifyKey;
  policyMode?: SentinelPolicyMode;
  maxBodyBytes?: number;
  rateLimiter?: SentinelRateLimiter;
};

type ParsedRequest =
  | { ok: true; value: SentinelCheckRequest }
  | { ok: false; code: "invalid_request" | "invalid_direction" };

function optionalBoundedString(
  value: unknown,
  maxLength: number,
): { ok: true; value?: string } | { ok: false; code: "invalid_request" } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    return { ok: false, code: "invalid_request" };
  }
  return { ok: true, value };
}

export function parseSentinelRequest(value: unknown): ParsedRequest {
  if (!isRecord(value)) return { ok: false, code: "invalid_request" };
  if (Object.prototype.hasOwnProperty.call(value, "owner")) {
    return { ok: false, code: "invalid_request" };
  }
  const textValue = value.text ?? value.turn;
  if (typeof textValue !== "string" || textValue.trim() === "") {
    return { ok: false, code: "invalid_request" };
  }
  const direction = value.direction;
  if (typeof direction !== "string") {
    return { ok: false, code: "invalid_direction" };
  }
  if (direction === "input" || !SENTINEL_DIRECTIONS.includes(direction as SentinelDirection)) {
    return { ok: false, code: "invalid_direction" };
  }

  let context: SentinelCheckRequest["context"];
  if (value.context !== undefined) {
    if (!isRecord(value.context)) return { ok: false, code: "invalid_request" };
    if (Object.prototype.hasOwnProperty.call(value.context, "owner")) {
      return { ok: false, code: "invalid_request" };
    }
    const taskId = optionalBoundedString(value.context.taskId, 256);
    if (!taskId.ok) return taskId;
    const plugin = optionalBoundedString(value.context.plugin, 128);
    if (!plugin.ok) return plugin;
    const subtask = optionalBoundedString(value.context.subtask, 128);
    if (!subtask.ok) return subtask;
    let recentCategories: SentinelCategory[] | undefined;
    if (value.context.recentCategories !== undefined) {
      if (!Array.isArray(value.context.recentCategories) || value.context.recentCategories.length > 16) {
        return { ok: false, code: "invalid_request" };
      }
      const categories: string[] = [];
      for (const category of value.context.recentCategories) {
        if (typeof category !== "string" || !SENTINEL_CATEGORIES.includes(category as SentinelCategory)) {
          return { ok: false, code: "invalid_request" };
        }
        if (!categories.includes(category)) categories.push(category);
      }
      recentCategories = categories.sort(
        (left, right) =>
          SENTINEL_CATEGORIES.indexOf(left as SentinelCategory) - SENTINEL_CATEGORIES.indexOf(right as SentinelCategory),
      ) as typeof recentCategories;
    }
    context = {
      ...(taskId.value === undefined ? {} : { taskId: taskId.value }),
      ...(plugin.value === undefined ? {} : { plugin: plugin.value }),
      ...(subtask.value === undefined ? {} : { subtask: subtask.value }),
      ...(recentCategories === undefined ? {} : { recentCategories }),
    };
  }
  return {
    ok: true,
    value: {
      text: textValue,
      direction: direction as SentinelCheckRequest["direction"],
      ...(context === undefined ? {} : { context }),
    },
  };
}

function checkRateLimiter(
  limiter: SentinelRateLimiter,
  owner: string,
): RateLimitResult {
  if (typeof limiter === "function") {
    return { allowed: limiter(owner), retryAfterSeconds: 1 };
  }
  return limiter.check(owner);
}

function bodyByteLength(c: Context, value: unknown): number {
  const contentLength = c.req.header("content-length");
  if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
    return Number(contentLength);
  }
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function createSentinelRoutes(opts: SentinelRoutesOptions): Hono {
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_SENTINEL_MAX_BODY_BYTES;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const service =
    opts.service ??
    new SentinelService({
      ledger: opts.ledger,
      policy: policyForMode(opts.policyMode ?? "advisory"),
    });
  const limiter =
    opts.rateLimiter ??
    createPerOwnerRateLimiter({ ratePerMinute: 60, burst: 20 });
  const routes = new Hono();

  routes.use(
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) => c.json({ error: "request_too_large" }, 413),
    }),
  );

  routes.post("/sentinel/check", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);
    const owner = auth.owner;
    if (isDeleting(owner)) return accountDeletedResponse(c);
    const rate = checkRateLimiter(limiter, owner);
    if (!rate.allowed) {
      const response = c.json({ error: "rate_limited" }, 429);
      response.headers.set("retry-after", String(rate.retryAfterSeconds));
      return response;
    }
    const body = await c.req.json().catch(() => null);
    if (bodyByteLength(c, body) > maxBodyBytes) {
      return c.json({ error: "request_too_large" }, 413);
    }
    const parsed = parseSentinelRequest(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.code }, 400);
    }
    if (isDeleting(owner)) return accountDeletedResponse(c);
    try {
      const result = service.check(owner, parsed.value);
      const responseBody = {
        ...result.verdict,
        ...(result.ledgerTaskId === null ? {} : { ledgerTaskId: result.ledgerTaskId }),
      };
      return c.json(responseBody);
    } catch (error) {
      if (error instanceof SentinelTaskNotFoundError) {
        return c.json({ error: "not_found" }, 404);
      }
      console.error("sentinel: check failed");
      return c.json({ error: "internal" }, 500);
    }
  });

  return routes;
}
