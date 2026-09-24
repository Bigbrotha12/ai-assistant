import { redactForOutbound } from "./redact.ts";

export const DEFAULT_TOOL_RESPONSE_MAX_BYTES = 1_048_576;
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 65_536;
export const DEFAULT_TOOL_ARGS_MAX_BYTES = 1_048_576;
export const DEFAULT_TOOL_ARGS_MAX_DEPTH = 32;
export const DEFAULT_TOOL_HANDLER_TIMEOUT_MS = 60_000;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";
export const NON_TEXT_TOOL_RESULT_MARKER = "[tool result omitted: non-text payload]";

export type ToolResourceErrorCode =
  | "tool_timeout"
  | "tool_result_too_large"
  | "tool_args_too_large"
  | "tool_args_too_deep"
  | "tool_args_not_serializable";

export class ToolResourceError extends Error {
  readonly code: ToolResourceErrorCode;
  readonly limit: number;
  readonly unit: "milliseconds" | "bytes" | "characters" | "depth";

  constructor(
    code: ToolResourceErrorCode,
    message: string,
    limit: number,
    unit: "milliseconds" | "bytes" | "characters" | "depth",
  ) {
    super(message);
    this.name = "ToolResourceError";
    this.code = code;
    this.limit = limit;
    this.unit = unit;
  }
}

function assertPositiveLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

export function serializeBoundedToolArguments(
  args: unknown,
  maxBytes = DEFAULT_TOOL_ARGS_MAX_BYTES,
  maxDepth = DEFAULT_TOOL_ARGS_MAX_DEPTH,
): string {
  assertPositiveLimit("maxBytes", maxBytes);
  assertPositiveLimit("maxDepth", maxDepth);
  const seen = new WeakSet<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw new ToolResourceError(
        "tool_args_too_deep",
        `tool arguments exceed depth ${maxDepth}`,
        maxDepth,
        "depth",
      );
    }
    if (typeof value !== "object" || value === null) return;
    if (seen.has(value)) {
      throw new ToolResourceError(
        "tool_args_not_serializable",
        "tool arguments are not a finite JSON value",
        maxDepth,
        "depth",
      );
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else {
      for (const entry of Object.values(value)) visit(entry, depth + 1);
    }
    seen.delete(value);
  };
  visit(args, 0);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(args);
  } catch {
    throw new ToolResourceError(
      "tool_args_not_serializable",
      "tool arguments are not JSON-serializable",
      maxBytes,
      "bytes",
    );
  }
  if (serialized === undefined) {
    throw new ToolResourceError(
      "tool_args_not_serializable",
      "tool arguments are not JSON-serializable",
      maxBytes,
      "bytes",
    );
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    throw new ToolResourceError(
      "tool_args_too_large",
      `tool arguments exceed ${maxBytes} bytes`,
      maxBytes,
      "bytes",
    );
  }
  return serialized;
}

export type BoundedToolHandlerOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  maxResultChars?: number;
  timeoutMessage?: string;
};

export async function invokeBoundedToolHandler(
  run: (signal: AbortSignal) => Promise<unknown> | unknown,
  opts: BoundedToolHandlerOptions,
): Promise<string> {
  assertPositiveLimit("timeoutMs", opts.timeoutMs);
  const maxResultChars = opts.maxResultChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  assertPositiveLimit("maxResultChars", maxResultChars);
  opts.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  let timedOut = false;
  let timeoutError: ToolResourceError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let work: Promise<unknown>;
  try {
    work = Promise.resolve().then(() => run(signal));
  } catch (error) {
    work = Promise.reject(error);
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      timeoutError = new ToolResourceError(
        "tool_timeout",
        opts.timeoutMessage ?? `tool handler exceeded ${opts.timeoutMs}ms`,
        opts.timeoutMs,
        "milliseconds",
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, opts.timeoutMs);
  });
  try {
    const result = await Promise.race([work, timeout]);
    signal.throwIfAborted();
    return boundToolResult(typeof result === "string" ? result : String(result), maxResultChars);
  } catch (error) {
    if (timedOut && timeoutError) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function boundToolResult(
  content: string,
  maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS,
): string {
  assertPositiveLimit("maxChars", maxChars);
  if (maxChars <= TOOL_RESULT_TRUNCATION_MARKER.length) {
    throw new RangeError(
      `maxChars must exceed ${TOOL_RESULT_TRUNCATION_MARKER.length}`,
    );
  }
  const redacted = redactForOutbound(content);
  if (redacted.length <= maxChars) return redacted;
  let prefix = redacted.slice(0, maxChars - TOOL_RESULT_TRUNCATION_MARKER.length);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1);
  return prefix + TOOL_RESULT_TRUNCATION_MARKER;
}

export function boundToolResultContent(
  content: unknown,
  maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS,
): string {
  return typeof content === "string"
    ? boundToolResult(content, maxChars)
    : NON_TEXT_TOOL_RESULT_MARKER;
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_TOOL_RESPONSE_MAX_BYTES,
  signal?: AbortSignal,
): Promise<string> {
  assertPositiveLimit("maxBytes", maxBytes);
  signal?.throwIfAborted();
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ToolResourceError(
      "tool_result_too_large",
      `tool response exceeds ${maxBytes} bytes`,
      maxBytes,
      "bytes",
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ToolResourceError(
          "tool_result_too_large",
          `tool response exceeds ${maxBytes} bytes`,
          maxBytes,
          "bytes",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    signal?.throwIfAborted();
    return text;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
