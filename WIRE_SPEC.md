# Wire spec — OpenAI-compatible chat SSE contract

**Source of truth.** This is the byte-level contract between the server SSE adapter
(`server/src/transport/openai.ts`) and the Flutter client SSE parser
(`lib/features/chat/data/sse.dart`). Both sides implement against this file; no
implementation decision may silently change it. The canonical frame sequences in §7 are the
golden-test fixtures.

Verified against `8841130`. Sections are numbered stably — code comments reference §3.3,
§3.4, §4, §5.1, §5.2, §6, §7.4 and Appendix A by number.

---

## 1. Scope and invariants

The gateway exposes `POST /v1/chat/completions` speaking OpenAI chat-completions SSE
(`stream: true`). The response is produced by translating a LangGraph
`streamEvents(version: "v2")` iterable into OpenAI frames.

Two translation boundaries are load-bearing:

- **Graph vocabulary never reaches the wire.** LangGraph event names, run ids, tags, and
  `data.chunk` internals are server-side only (§6, Appendix A).
- **A graph run collapses into exactly one chat-completion turn.** LangGraph is a multi-node
  DAG with no intrinsic concept of a single turn ending in one finish reason; §4 fixes how
  that collapse is encoded.

### Core invariants (non-negotiable)

| # | Invariant |
|---|-----------|
| I1 | **Exactly one terminal event.** Every stream ends with exactly one `data: [DONE]\n\n` frame. No other frame terminates a stream — in particular, a chunk carrying `finish_reason` does *not* terminate it. |
| I2 | **No mid-stream `finish_reason`.** `finish_reason` appears only on the terminal chunk (the chunk immediately preceding `[DONE]`). Tool-call deltas are emitted for display only and never carry `finish_reason`. |
| I3 | **`finish_reason` is sticky.** The first non-null `finish_reason` observed by the client is never overwritten by later frames. At `[DONE]`, the accumulated value is final — `null` if none was ever sent. |
| I4 | **`[DONE]` is the sole terminator.** A stream is complete only when `[DONE]` is read. An error frame followed by `[DONE]` is valid; an error frame alone (connection close after it) is also valid and must be handled as terminal. |

---

## 2. Transport and frame format

### HTTP

- Method `POST /v1/chat/completions`; request carries `stream: true`.
- Response headers, exactly: `content-type: text/event-stream` and
  `cache-control: no-cache`. No other SSE header is part of the contract.
- Chunked transfer is permitted; the client reads a byte stream and frames on `\n`.

### SSE framing

The wire is standard Server-Sent Events as consumed by the OpenAI SDK:

```
data: <payload>
<blank line>
```

- Every event is exactly **one `data:` field line followed by a blank line**
  (`data: <payload>\n\n`). LF (`\n`) is the mandated line terminator; `\r\n` is tolerated on
  read.
- The `data:` payload is **compact single-line JSON** — the adapter MUST NOT spread JSON
  across multiple `data:` lines.
- Comment lines (`: …\n\n`) MAY appear anywhere and MUST be ignored by the client.
- Empty `data:` lines and blank lines MUST be ignored.
- A frame MUST NOT contain both `choices` and `error` at the top level — they are mutually
  exclusive.

### Shared chunk envelope

Content and tool-call chunks are OpenAI `chat.completion.chunk` objects:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion.chunk",
  "created": 1726080000,
  "model": "gpt-4o",
  "choices": [
    { "index": 0, "delta": { "…": "…" }, "finish_reason": null }
  ]
}
```

- `id`, `object`, `created`, `model` are **required on the first frame** the adapter emits
  and omitted on every subsequent frame. When present they MUST be identical across the
  stream (`id` and `created` never change; `model` is the value echoed from the request, or
  the server default `langchain-agent`).
- The adapter emits **exactly one choice** (`index: 0`). Clients MUST ignore non-zero
  choices if they ever appear.
- Clients MUST ignore unknown/extra top-level fields (`usage`, `chat_template_kwargs`,
  `enable_thinking`, …).
- `created` is epoch **seconds**.

The envelope is claimed by whichever frame is emitted first. For a degenerate run whose
first frame is the finish chunk, that chunk carries the envelope.

---

## 3. Event types

### 3.1 Content delta chunk

```json
{ "choices": [{ "index": 0, "delta": { "content": "Hello" }, "finish_reason": null }] }
```

- `delta.content` is a non-empty string fragment. The adapter MUST NOT emit a content frame
  with empty or null content.
- Concatenating all content fragments over the stream yields the assistant's text.
- MAY (first chunk only) carry `delta.role: "assistant"`; clients MUST ignore it.

### 3.2 Tool-call delta chunk

```json
{
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_…",
        "type": "function",
        "function": { "name": "search_web", "arguments": "{\"q\": \"din" }
      }]
    },
    "finish_reason": null
  }]
}
```

- One entry per tool-call index. `delta.tool_calls[].index` is the **adapter-assigned call
  index**; `id` and `function.name` are set on the first fragment of a call only, and MAY be
  empty on later fragments.
- `function.arguments` is an incremental raw-JSON string fragment. The **concatenation of
  all argument fragments for a call index MUST be valid JSON**. The adapter normalizes a
  first fragment that lacks its leading `{` so this holds.
- **Display-only.** Tool-call deltas never carry `finish_reason` (I2) and never terminate
  the stream.
- Adapter-assigned `index` values are monotonically increasing in first-seen order across
  the whole graph run and are never reused. The model's own per-turn
  `tool_call_chunks[].index` is a separate namespace that resets each model turn.

### 3.3 Finish (terminal) chunk

```json
{ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] }
```

- Emitted **exactly once per stream**, immediately before `[DONE]`.
- `delta` is empty (`{}`); it carries no content.
- `finish_reason` is `"stop"` or `"tool_calls"` (§4). It is never `null` on an emitted
  finish chunk — a `null` decision means no finish chunk is emitted at all.
- It is **not** a terminator (I1): the client keeps reading until `[DONE]`.

### 3.4 Error envelope

```json
{
  "error": {
    "message": "web fetch failed: connection refused",
    "type": "tool_error",
    "code": "tool_execution_failed"
  }
}
```

- `message` — required, human-readable, displayable verbatim, **never contains
  credentials/API keys**. Only the first non-empty line of the underlying error text is sent.
- `type` — required, closed set: **`server_error` | `model_error` | `tool_error`**.
- `code` — optional, stable string for programmatic handling:
  - `tool_execution_failed` — always sent on a tool error.
  - the budget/context code (`budget_exhausted`, `context_length_exceeded`) when the
    underlying failure is a `BudgetExhaustedError` or `ContextBudgetError`.
  - omitted otherwise.
- Clients MUST treat an unknown `type`/`code` as `server_error` and always show `message`.
- An error envelope terminates the stream (§5.2). It is never followed by a finish chunk.

### `[DONE]`

The literal six-byte payload `data: [DONE]\n\n`. Sole terminator (I4). Emitted at most once
(I1). No JSON, no fields — the finish reason it "carries" is the client's accumulated sticky
value (I3, §4).

---

## 4. Finish-reason disposition

### Adapter (emit side)

1. `finish_reason` is emitted on **exactly one** frame per stream: the finish chunk (§3.3)
   immediately before `[DONE]`. Never mid-stream (I2).
2. The value is decided once:
   - **Seeded** by a provider `tool_calls` finish, observed on `on_chat_model_end` via
     `response_metadata.finish_reason`. This is the only provider value passed through.
   - Otherwise **decided at the root `on_chain_end`** from the final assistant output:
     - `"tool_calls"` — the output materialized one or more **complete** tool calls
       (non-empty `name` *and* non-empty `args`).
     - `"stop"` — the output has text content, **or** it carries tool calls that never
       completed (a real turn, not an empty run).
     - `null` — the empty run: no content and no tool calls at all. The adapter then emits
       **no finish chunk** and sends `[DONE]` immediately (§7.4). Do not synthesize `"stop"`
       for an empty run — `null` is the honest encoding.
3. Provider-specific values (`length`, `content_filter`, …) are **not** passed through. The
   wire set is `stop | tool_calls` only; additional values require a contract revision.
4. **Degenerate-stream fallback.** If the event iterable exhausts without a root
   `on_chain_end`/`on_chain_error` and without throwing, the adapter emits a `"stop"` finish
   chunk then `[DONE]`, guaranteeing I4. Real graph runs always deliver root termination;
   only degenerate streams reach this path.

### Client (parser, receive side)

1. Parse `finish_reason` from each chunk; store **only the first non-null value**.
   Subsequent values, including `null`, never overwrite it.
2. `null` never clears a stored value.
3. At `[DONE]`, finalize: the stored value is the stream's finish reason, or `null` if none
   was ever sent.
4. `null` / missing maps to the client's non-tool behavior (`'stop'`), which is the default
   for the managed client.

---

## 5. Error handling

Two distinct phases. HTTP status is only meaningful before streaming starts.

### 5.1 Pre-stream errors (HTTP, no SSE)

Detected before the first streamed byte, so they are returned as a plain JSON body — **not**
SSE:

```
HTTP/1.1 429 Too Many Requests
content-type: application/json
retry-after: 12

{"error":"busy"}
```

**Shape:** a flat object `{"error": "<code>"}`. `message` is added when the server has
human-readable detail to give; some codes add structured fields. There is no `type` field on
the wire — the parenthesised `type` names in the table below are conceptual groupings used
by the client's error taxonomy, not serialized.

| HTTP | `error` | Extra fields | Meaning (conceptual type) |
|---|---|---|---|
| 400 | `invalid_request` | `message?` | Malformed JSON; missing/unknown/non-model/non-streaming model plugin; missing or empty messages; managed request without a valid `session_id`; session delta whose last message is not a user message; invalid `agent` value (conceptual `invalid_request_error`) |
| 400 | `invalid_credentials` | `message?` | Missing/invalid model-plugin or granted-tool credentials (conceptual `auth_error`, user-fixable) |
| 400 | `unsupported` | `message` | Model plugin exists but cannot serve this request (e.g. non-streaming) |
| 400 | `context_length_exceeded` | `message` | Request exceeds the context budget (`ContextBudgetError`) |
| 401 | `unauthorized` | — | Missing/invalid gateway key |
| 403 | `email_not_verified` | — | Valid key, owner's email unconfirmed |
| 403 | `account_deleted` | — | Owner is mid-deletion |
| 404 | `not_found` | — | Addressed resource is absent or not the caller's (sessions, ledger, reports) |
| 409 | `session_missing` | `reason: "evicted" \| "restart"` | Managed-session `session_id` is gone; client re-establishes under the **same** `session_id` |
| 409 | `conversation_in_flight` | `sessionId`, `messageId` | A managed-session turn with this `messageId` is already running |
| 409 | `message_thread_conflict` | `taskId`, `threadId` | A background task with this `messageId` belongs to a different worker |
| 413 | `request_too_large` | — | Body exceeds the path's cap |
| 429 | `rate_limited` | `retry-after` | Per-owner rate limiter rejected the request |
| 429 | `busy` | `retry-after` | Per-user budget pool full (sync path; concurrent-capacity, retryable) |
| 429 | `budget_exhausted` | `message`, `retry-after` | Model-call budget exhausted (`BudgetExhaustedError`) |
| 500 | `internal` | — | Anything else; logged server-side (conceptual `server_error`) |
| 502 | `inference_unavailable` | — | Plugin registry unavailable, or the model/agent catalog failed to load |
| 502 | `tools_unavailable` | `message` | The request asked for tools but zero bound (policy denial, unreachable MCP server, broken plugin) — surfaces a misconfiguration instead of silently running chat-only |
| 503 | `busy` | `retry-after` | Per-user budget queue full (async path; concurrent-capacity, retryable) |
| 503 | `background_unavailable` | — | Async path not wired |

**Client behavior.** Read `error` as the code; if the body nests it (an `error` object), take
`code` then `type`. Codes outside the client's allowlist degrade to `server_error`. Honor
`retry-after` (delta-seconds or HTTP-date) on 429/503.

**Success shaped like a duplicate.** A re-sent `messageId` that already completed returns
**200** (not an error): `{"status":"already_completed", …}` — see §10.

### 5.2 Mid-stream errors (in-band SSE)

Once the adapter has started flushing `200 + text/event-stream`, an error can no longer
change the HTTP status. Mid-stream failures are conveyed in-band:

1. Emit **exactly one** error envelope frame (§3.4).
2. Then emit `data: [DONE]\n\n`, preserving I4. The adapter always emits `[DONE]` after an
   in-band error, including the safety-net path for failures LangGraph throws out of
   `streamEvents` without delivering an `on_chain_error` event.
3. Never emit a finish chunk after an error frame; `finish_reason` is not sent on an aborted
   stream.

The client MUST treat the error frame as terminal, surface `message`, and stop reading. It
MUST tolerate both a trailing `[DONE]` and a bare connection close after the error frame
(I4), and MUST NOT double-report.

---

## 6. `streamEvents()` → OpenAI mapping

The adapter linearizes LangGraph v2 events in the order they are yielded and translates in
that order. The run tree (subgraphs, parallel tool nodes) is invisible on the wire.

| LangGraph / LangChain event | Wire effect |
|---|---|
| `on_chat_model_start`, `on_llm_start` | none — resets the per-turn tool-call index namespace |
| `on_chat_model_stream` | `data.chunk` → content delta(s), then tool-call delta(s) (below) |
| `on_llm_stream` | `data.chunk.text` → one content delta, if non-empty. Legacy non-chat-model pipelines |
| `on_chat_model_end` | none emitted (content already streamed). A provider `finish_reason: "tool_calls"` seeds §4 |
| `on_chat_model_error`, `on_llm_error` | error envelope, `type: model_error` → terminator |
| `on_tool_start`, `on_tool_end` | none — tool execution is silent on the wire |
| `on_tool_error` | error envelope, `type: tool_error`, `code: tool_execution_failed` → terminator |
| `on_chain_start` | none (the outermost one is tracked as the root run) |
| `on_chain_stream` | string chunks → content delta; objects carrying `tool_call_chunks` → tool-call deltas; state-shaped chunks (the supervisor graph's `messages` updates) are ignored |
| `on_chain_end` | **root run only:** decides `finish_reason` (§4) → finish chunk → `[DONE]`. Non-root runs: no-op |
| `on_chain_error` | **root run only:** error envelope, `type: server_error` → terminator. Non-root (sub-handled) errors never reach the wire |
| anything else | no-op |

### `on_chat_model_stream` → frames

- `data.chunk` is the accumulated message chunk itself; a producer that wraps it as
  `{ message }` is accepted.
- `message.content`:
  - **string** → one content delta, unless empty (empty never produces a frame).
  - **array of content blocks** → only `type: "text"` blocks contribute their `text`;
    non-text blocks (images, tool markers) are skipped.
- `message.tool_call_chunks` (`Array<{ index?, id?, name?, args? }>`) → one tool-call delta
  entry each, mapped to the adapter-assigned call index (§3.2). `id`/`name` on the first
  fragment only; `args` is an incremental raw-JSON fragment, normalized so the concatenation
  is valid JSON.
- A single event MAY produce both a content delta and tool-call deltas; the adapter emits
  them as separate frames, content first.

### Termination, exactly once

Only the root run's `on_chain_end` emits the finish chunk + `[DONE]`. Intermediate model
completions (e.g. an orchestrator turn followed by a final-answer turn) stream their deltas
with **no** `finish_reason` and **no** per-node terminator. A run that produces neither
content nor tool-call deltas emits nothing before `[DONE]` (§7.4).

---

## 7. Canonical frame sequences (golden-test fixtures)

Each `data:` line is followed by one blank line. Frames after the first omit
`id`/`object`/`created`/`model` per §2.

### 7.1 Simple text completion — `finish_reason: "stop"`

```
data: {"id":"chatcmpl-001","object":"chat.completion.chunk","created":1726080000,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"."},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

```

### 7.2 Tool-call stream — `finish_reason: "tool_calls"`

```
data: {"id":"chatcmpl-002","object":"chat.completion.chunk","created":1726080060,"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9y3","type":"function","function":{"name":"search_web","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":"{\"q\":\"dinner "}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"","arguments":"recipes\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

```

`id`/`name` appear only on the first fragment; the argument fragments concatenate to the
valid JSON `{"q":"dinner recipes"}`. No `finish_reason` appears on any delta frame (I2).

### 7.3 Mid-stream error — error frame → `[DONE]`

```
data: {"id":"chatcmpl-003","object":"chat.completion.chunk","created":1726080120,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me check"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":" that for you"},"finish_reason":null}]}

data: {"error":{"message":"web fetch failed: connection refused","type":"tool_error","code":"tool_execution_failed"}}

data: [DONE]

```

No finish chunk and no `finish_reason`, so the client's accumulated value is `null` (I3). The
client also accepts a bare connection close after the error frame (I4).

### 7.4 Empty completion — no content, immediate `[DONE]`

```
: empty completion: graph produced no output; finish_reason stays null
data: [DONE]

```

No finish chunk. The accumulated `finish_reason` is `null` (I3) and the client maps that to
the non-tool path (§4, receive side).

---

## 8. Client parser requirements

`lib/features/chat/data/sse.dart` implements the receive side.

1. **Frame on lines.** Read lines; ignore blank lines, `:` comments, and empty `data:`
   payloads. Parse each `data:` payload as JSON, tolerating `\r\n`.
2. **`[DONE]` is the sole terminator.** Emit exactly one `done` event and stop only on
   `data: [DONE]`. A finish chunk (§3.3) does *not* terminate parsing.
3. **Sticky `finish_reason`.** Store the first non-null value; never overwrite it with a
   later value or `null`. At `[DONE]`, emit `done` with the accumulated value (`null` if none
   was sent). Never null it out — `'tool_calls'` must survive to the tool-call chips.
4. **Materialize tool calls from accumulated arguments.** Concatenate `function.arguments`
   fragments per index; decode JSON. `id`/`name` come from the first fragment. A failed
   decode must not silently drop the tool call.
5. **Error envelope is terminal.** On `{"error": {…}}`, surface `message`, mark the stream
   failed, and stop — do not wait for `[DONE]`, and do not emit `done`. Tolerate a trailing
   `[DONE]` without double-reporting.
6. **EOF handling.** EOF without `[DONE]` is tolerated: emit `done` with the sticky value and
   let the caller treat it as a normal non-tool turn. A zero-byte EOF (no frames read) is a
   connection failure and is retried. The adapter MUST emit `[DONE]`; strictness is a
   producer obligation, tolerance is a client convenience.
7. **Ignore unknown fields.** `id`, `object`, `created`, `model`, `usage`, `delta.role`, and
   any future top-level fields MUST NOT affect parsing.
8. **Single choice.** Parse `choices[0]` only; ignore others.
9. **Empty content frames.** Any `delta.content` that is not a non-empty string is ignored.
   Thinking-block and structured-token stripping is client-side and happens before the
   content is surfaced.
10. **Brace-prefix tolerance.** The client MAY re-prefix a first argument fragment that lacks
    its leading `{`. This is a defensive fallback for non-conforming producers; the adapter
    (§6) is required to emit conforming frames.

---

## 9. Conformance and golden fixtures

- §7.1–§7.4 are the canonical fixtures. Server-side golden tests
  (`server/test/transport/openai.test.ts`) assert the adapter's output byte-for-byte against
  them. Client-side tests (`test/features/chat/sse_test.dart`, using the shared fixtures in
  `test/features/chat/sse_fixtures.dart`) assert the parser against frames of the same shape,
  semantics, and framing.
- Contract behaviours the goldens must cover:
  - sticky finish: §7.2 parses with `finish_reason == "tool_calls"` and the tool calls
    materialized;
  - exactly one `done` event per stream (§7.1 and §7.4);
  - §7.4 yields `done(null)` and maps to the non-tool path;
  - §7.3 yields exactly one error and no `done`, with and without a trailing `[DONE]`;
  - single `data:` line per frame, envelope on the first frame only, `[DONE]` terminator.

---

## 10. Managed conversation sessions

Conversation identity on the synchronous path is `session_id`. Managed requests
(`conversation_mode: "managed"`) REQUIRE a non-empty `session_id` and a `messageId`; the
gateway keeps conversation state in an in-memory, evictable session store. The client is
authoritative on history.

### Request — establish vs delta

A body is an **establish** when it is managed, carries a `session_id`, and either:

- carries **more than one** message (full history — a first turn, a reseed, or a compaction
  re-base; a re-base is an establish even against a live session, and the server REPLACES
  the stored history), **or**
- carries **exactly one** message against a session the store reports as missing with reason
  `"restart"` (the first turn of a brand-new conversation).

Everything else is a **delta**: a single new user message, appended to the session.

- Establish → response carries `x-conversation-state: seeded`.
- Delta → response carries `x-conversation-state: resumed`.

### Response headers (managed turns)

| Header | Value |
|---|---|
| `x-session-id` | Echoes the request's `session_id`. Set on the session path. |
| `x-conversation-state` | `seeded` \| `resumed`. **`recreated` is never emitted.** Set on every managed 2xx and on duplicate 409s. |
| `x-thread-id` | Set only on background duplicate responses (§ background). |

### Exactly-once dedupe

A re-sent `messageId` that already `completed` on the session path returns:

```
200 {"status":"already_completed","sessionId":"…","messageId":"…"}
```

— no `taskId`, no `terminalStatus`, no `threadId`. The caller reads the reply back via
`GET /v1/sessions/:id`. A concurrent turn with the same `messageId` returns
`409 conversation_in_flight`. A retry of a `failed` `messageId` is a clean re-run and
streams normally.

### Session miss

A delta against a missing or evicted session returns
`409 {"error":"session_missing","reason":"evicted" | "restart"}`. The client re-establishes
under the **same** `session_id` — never a new one.

### Conversation surface

| Route | Success | Failure |
|---|---|---|
| `GET /v1/sessions/:id` | `200 {sessionId, messages}` | Another owner → `404 not_found`; own session gone → `409 session_missing` (+`reason`) |
| `DELETE /v1/sessions/:id` | `200 {status:"ok"}` | Another owner or absent → `404 not_found` (never a successful delete) |

Both set `cache-control: no-store`. Messages are serialized as
`{ role, content, tool_calls?, tool_call_id? }`, where `role ∈ system | user | assistant |
tool`; `tool_calls` appears on assistant messages and `tool_call_id` on tool messages. The
cross-owner 404 exists so a caller cannot distinguish "not yours" from "does not exist" by
content — only the id's ownership is disclosed.

### Background submission

`{ background: true, messageId, messages: [full history], … }` runs on the submitted
snapshot and returns immediately:

```
202 {"status":"accepted","taskId":"…","threadId":"…"}
```

Status and terminal output are polled via `GET /ledger/tasks/by-key/:messageId`. A duplicate
background admission returns `409 conversation_in_flight` (running),
`409 message_thread_conflict` (wrong worker), or `200 {status:"already_completed",
terminalStatus, taskId, threadId}` (terminal) — this is the background shape, distinct from
the session-path duplicate above. `thread_id` exists only as the background job's worker
label.

---

## 11. Agent selection

Managed and background requests MAY carry an `agent` field. Absent, the gateway runs the
default supervisor prompt.

**`agent` = string (template id).** The gateway resolves the template from its mounted
catalog. Unknown id → `400 invalid_request` with `message: "template_not_found: <id>"`.

**`agent` = object (custom spec).** Validated strictly — unknown keys are rejected with
`400 invalid_request` and the zod issue list in `message`:

```json
{
  "name": "…",
  "description": "…",
  "systemPrompt": "…",
  "skills": ["<skill-id>"],
  "mcpServers": [{ "name": "…" }],
  "tools": [{ "pluginId": "…", "required": false }],
  "modelRef": "<model-plugin-id>",
  "inference": { "temperature": 0.7, "maxTokens": 4096, "visionCapable": false }
}
```

- `name` ≤ 100, `description` ≤ 300. The remaining caps come from
  `AGENT_SPEC_MAX_SYSTEM_PROMPT`, `AGENT_SPEC_MAX_SKILLS`, `AGENT_SPEC_MAX_MCPS`,
  `AGENT_SPEC_MAX_TOOLS`.
- `temperature` is **clamped** to `[0, 2]` rather than rejected; `maxTokens` must be a
  positive integer ≤ 200000; `visionCapable` defaults to `false`.
- Sub-objects (`mcpServers[]`, `tools[]`, `inference`) are strict.
- Client-supplied MCP `url`/`headers` are rejected — URLs come only from the server catalog.
  `skills` and `mcpServers` entries unknown to the catalog are skipped with a warning.

### Semantics (sync and background alike)

- `modelRef` overrides `model` and must resolve to an installed, streaming model. The client
  MUST supply that model's credentials in `credentials`, or resolution fails with
  `400 invalid_credentials`.
- `tools` overrides `enabled_plugins` **exclusively** when non-empty; an empty array permits
  no tool plugins; absent keeps the request's own selection. A `required: true` grant whose
  plugin is not installed, or whose credentials are missing, fails closed with
  `400 invalid_credentials`.
- `inference` overrides the request's `parameters` when present.

### Client behavior

The client resolves the persisted selection at send construction: a template agent is sent as
its string id, a custom agent as its spec object, with credentials for the agent's `modelRef`
and granted tools riding in `credentials`. The agent is frozen into the per-turn service and
the retry envelope, so a retry replays the identical agent. A template deleted server-side
degrades to no agent rather than failing the send.

### `GET /v1/agents`

Owner-authenticated. Returns an OpenAI-style list envelope:

```json
{
  "object": "list",
  "data": [{
    "id": "…",
    "object": "agent",
    "created": 1726080000,
    "owned_by": "plugin",
    "name": "…",
    "description": "…",
    "defaultModel": "…",
    "visionCapable": false,
    "temperature": 0.7,
    "maxTokens": 4096,
    "toolGrants": [{ "pluginId": "…", "required": false }],
    "skillCount": 2,
    "skillIds": ["…"],
    "mcpNames": ["…"],
    "source": "template"
  }]
}
```

Entries are sorted by `id`. `systemPrompt` and skill contents are never serialized.
`created` is epoch seconds and reflects response time, not a stored value. `source` is
currently always `"template"`; the field is reserved for a future `"plugin"` origin.

---

## Appendix A — Not on the wire

- **No LangGraph event names, run ids, tags, or `data.chunk` internals.** The client never
  sees `on_*` events.
- **No mid-stream `finish_reason`** on any delta frame — only §3.3.
- **No more than one `[DONE]`**, and no other terminator tokens (`data: [ERROR]`,
  `data: null`, …). `[DONE]` and the error envelope are the only terminators.
- **No multi-line `data:` payloads.**
- **No credential material** in error messages, chunk metadata, or any field.
- **No per-node terminator** for intermediate model turns — a whole graph run is one chat
  completion turn (I1).
- **No `type` field on pre-stream HTTP errors** — the flat error shape is `{"error": code}`
  (§5.1). The `type` field exists only on the in-band error envelope (§3.4).
