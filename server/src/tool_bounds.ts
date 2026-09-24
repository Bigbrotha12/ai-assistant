import { redactForOutbound } from "./redact.ts";

export const DEFAULT_TOOL_RESPONSE_MAX_BYTES = 1_048_576;
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 65_536;
export const TOOL_RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";
export const NON_TEXT_TOOL_RESULT_MARKER = "[tool result omitted: non-text payload]";

export type ToolResourceErrorCode = "tool_timeout" | "tool_result_too_large";

export class ToolResourceError extends Error {
  readonly code: ToolResourceErrorCode;
  readonly limit: number;
  readonly unit: "milliseconds" | "bytes" | "characters";

  constructor(
    code: ToolResourceErrorCode,
    message: string,
    limit: number,
    unit: "milliseconds" | "bytes" | "characters",
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
