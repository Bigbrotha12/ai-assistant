import {
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from "@langchain/core/messages";
import { CREDENTIAL_REDACTION } from "./plugins/credential.ts";

/**
 * Credential redaction (stateless-gateway, step 8). The SQLCipher checkpoint
 * store this module once wrapped is gone (plan §9) — no checkpoint DB is ever
 * opened — but `redactForOutbound` survives because every outbound path
 * (the ToolExecutor, the tool-result cache, the transports) still masks
 * credential-shaped material in tool results before they reach graph state or
 * the ledger.
 *
 * Masks `Authorization: <value>` headers (Bearer AND Basic/generic, value to
 * end-of-line), bare `Bearer <token>` occurrences, configured `sk`-prefixed API keys,
 * `Api-Key`/`X-Api-Key` headers, and quoted JSON `api_key`/`token`/`secret`/
 * `authorization` fields with `CREDENTIAL_REDACTION` (`***`), reusing the
 * marker from `plugins/credential.ts`. Never logs anything itself.
 */

const AUTHORIZATION_BEARER = /Authorization\s*:\s*Bearer\s+\S+/gi;
// Generic `Authorization: <value>` — but never the Bearer form, which the
// previous pattern already handles (a bare `\S+` would swallow the word
// "Bearer" and double-mask it). Masks the WHOLE value to end-of-line: a Basic
// or generic token ("Basic dXNlcjpwYXNz") carries its credential in the first
// token AND potentially more on the same line, so a single `\S+` left the tail
// unmasked. `[^\n\r]*` (no `m` flag needed) never crosses into the next line.
const AUTHORIZATION_GENERIC = /Authorization\s*:\s*(?!Bearer\b)\S+[^\n\r]*/gi;
const BARE_BEARER = /Bearer\s+\S+/gi;
const SK_KEY = /\bsk[-_]?[A-Za-z0-9]{20,}\b/g;
const DOCUMENTED_KEY_FORMATS =
  /\b((?:sk-or-(?:v\d+-)?|sk-ant-(?:api\d+-)?|sk-proj-|tok-))[A-Za-z0-9][A-Za-z0-9_-]{19,}(?![A-Za-z0-9_-])/g;
// Non-Bearer credential header fields: `Api-Key: ...`, `X-Api-Key: ...`
// (any case). Masks the value to end-of-line, keeping the field name.
const API_KEY_HEADER = /(\b(?:x-)?api[-_]?key\s*:\s*)[^\n\r]*/gi;
// JSON-style credential fields: `"api_key": "abc123"`, `"apiKey": "..."`,
// `"x-api-key": "..."`, `"token": "..."`, `"secret": "..."`,
// `"authorization": "..."`. Only quoted values are masked (a numeric/bool
// literal is not key material); the closing quote keeps the mask from
// swallowing a following key/value on the same line.
const JSON_CREDENTIAL_FIELD =
  /("|')((?:x-)?api[-_]?key|token|secret|authorization)(?:"|')\s*:\s*("|')([^"'\n]*)\3/gi;

/**
 * Masks credential-shaped material in a string before it is persisted into
 * checkpoint rows (tool results routinely echo API keys/bearer tokens back
 * into message content). Masks `Authorization: <value>` headers (Bearer AND
 * Basic/generic, value to end-of-line), bare `Bearer <token>` occurrences,
 * configured `sk`-prefixed API keys, `Api-Key`/`X-Api-Key` headers, and quoted JSON
 * `api_key`/`token`/`secret`/`authorization` fields with `CREDENTIAL_REDACTION`
 * (`***`), reusing the marker from `plugins/credential.ts`. The transport
 * (Wave C1 / Phase 3) applies this to message/tool-result content before the
 * graph writes it; the store keeps it here so the redaction discipline lives
 * next to the data it protects. Never logs anything itself.
 */
export function redactForOutbound(content: string): string {
  return content
    .replace(AUTHORIZATION_BEARER, `Authorization: Bearer ${CREDENTIAL_REDACTION}`)
    .replace(AUTHORIZATION_GENERIC, `Authorization: ${CREDENTIAL_REDACTION}`)
    .replace(BARE_BEARER, `Bearer ${CREDENTIAL_REDACTION}`)
    .replace(API_KEY_HEADER, `$1${CREDENTIAL_REDACTION}`)
    .replace(JSON_CREDENTIAL_FIELD, `$1$2$1: $3${CREDENTIAL_REDACTION}$3`)
    .replace(DOCUMENTED_KEY_FORMATS, `$1${CREDENTIAL_REDACTION}`)
    .replace(SK_KEY, `sk-${CREDENTIAL_REDACTION}`);
}

const MESSAGE_STRUCTURAL_FIELDS = new Set([
  "id",
  "name",
  "role",
  "type",
  "tool_call_id",
  "toolCallId",
  "callId",
  "created",
  "timestamp",
  "status",
]);
const CONTENT_STRUCTURAL_FIELDS = new Set([
  "id",
  "name",
  "type",
  "index",
  "tool_call_id",
  "toolCallId",
  "callId",
  "created",
  "timestamp",
  "status",
]);
const TOOL_STRUCTURAL_FIELDS = new Set(["id", "name", "type", "callId"]);
const METADATA_STRUCTURAL_FIELDS = new Set([
  "id",
  "role",
  "type",
  "tool_call_id",
  "toolCallId",
  "callId",
  "created",
  "timestamp",
  "status",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallContentBlock(value: Record<string, unknown>): boolean {
  return typeof value.type === "string" && value.type.includes("tool_call");
}

function redactValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (typeof value === "string") return redactForOutbound(value);
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(redactValue(item, seen));
    return result;
  }
  if (!isRecord(value)) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const entries: Array<[string, unknown]> = [];
  seen.set(value, entries);
  for (const [key, nested] of Object.entries(value)) {
    entries.push([key, redactValue(nested, seen)]);
  }
  return Object.fromEntries(entries);
}

function redactFunctionValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (!isRecord(value)) return redactValue(value, seen);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const entries: Array<[string, unknown]> = [];
  seen.set(value, entries);
  for (const [key, nested] of Object.entries(value)) {
    entries.push([
      key,
      key === "name" ? nested : redactValue(nested, seen),
    ]);
  }
  return Object.fromEntries(entries);
}

function redactToolCallValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (!isRecord(value)) return redactValue(value, seen);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const entries: Array<[string, unknown]> = [];
  seen.set(value, entries);
  for (const [key, nested] of Object.entries(value)) {
    if (TOOL_STRUCTURAL_FIELDS.has(key)) {
      entries.push([key, nested]);
    } else if (key === "args") {
      entries.push([key, redactValue(nested, seen)]);
    } else if (key === "function") {
      entries.push([key, redactFunctionValue(nested, seen)]);
    } else {
      entries.push([key, redactValue(nested, seen)]);
    }
  }
  return Object.fromEntries(entries);
}

function redactToolCalls(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (!Array.isArray(value)) return redactValue(value, seen);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const result: unknown[] = [];
  seen.set(value, result);
  for (const item of value) result.push(redactToolCallValue(item, seen));
  return result;
}

function redactMetadataValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(redactMetadataValue(item, seen));
    return result;
  }
  if (!isRecord(value)) return redactValue(value, seen);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const entries: Array<[string, unknown]> = [];
  seen.set(value, entries);
  for (const [key, nested] of Object.entries(value)) {
    if (METADATA_STRUCTURAL_FIELDS.has(key)) {
      entries.push([key, nested]);
    } else if (key === "tool_calls" || key === "tool_call_chunks") {
      entries.push([key, redactToolCalls(nested, seen)]);
    } else if (key === "function_call") {
      entries.push([key, redactFunctionValue(nested, seen)]);
    } else {
      entries.push([key, redactMetadataValue(nested, seen)]);
    }
  }
  return Object.fromEntries(entries);
}

function redactContentValue(
  value: unknown,
  seen: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (typeof value === "string") return redactForOutbound(value);
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const result: unknown[] = [];
    seen.set(value, result);
    for (const item of value) result.push(redactContentValue(item, seen));
    return result;
  }
  if (!isRecord(value)) return redactValue(value, seen);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const entries: Array<[string, unknown]> = [];
  seen.set(value, entries);
  for (const [key, nested] of Object.entries(value)) {
    if (
      CONTENT_STRUCTURAL_FIELDS.has(key) &&
      (key !== "name" || isToolCallContentBlock(value))
    ) {
      entries.push([key, nested]);
    } else if (key === "args") {
      entries.push([key, redactValue(nested, seen)]);
    } else if (key === "function") {
      entries.push([key, redactFunctionValue(nested, seen)]);
    } else {
      entries.push([key, redactContentValue(nested, seen)]);
    }
  }
  return Object.fromEntries(entries);
}

function redactStoredMessageData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(data)) {
    if (MESSAGE_STRUCTURAL_FIELDS.has(key)) {
      entries.push([key, value]);
    } else if (key === "content" || key === "content_blocks") {
      entries.push([key, redactContentValue(value)]);
    } else if (
      key === "tool_calls" ||
      key === "tool_call_chunks" ||
      key === "invalid_tool_calls"
    ) {
      entries.push([key, redactToolCalls(value)]);
    } else if (
      key === "additional_kwargs" ||
      key === "response_metadata" ||
      key === "usage_metadata" ||
      key === "metadata"
    ) {
      entries.push([key, redactMetadataValue(value)]);
    } else {
      entries.push([key, redactValue(value)]);
    }
  }
  return Object.fromEntries(entries);
}

export function redactMessageContent(
  content: BaseMessage["content"],
): BaseMessage["content"] {
  if (typeof content === "string") return redactForOutbound(content);
  if (!Array.isArray(content)) return content;
  return content.map((block) => redactContentValue(block)) as BaseMessage["content"];
}

export function redactBaseMessage(message: BaseMessage): BaseMessage {
  const stored = message.toDict();
  const data = redactStoredMessageData(
    stored.data as unknown as Record<string, unknown>,
  );
  const [redacted] = mapStoredMessagesToChatMessages([
    { ...stored, data: data as unknown as typeof stored.data },
  ]);
  if (!redacted) throw new Error("failed to redact message");
  return redacted;
}

export function redactMessages(
  messages: readonly BaseMessage[],
): BaseMessage[] {
  return messages.map(redactBaseMessage);
}
