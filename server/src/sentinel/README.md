# Sentinel

Sentinel is a server-owned deterministic safety layer. The gateway owns L1: it evaluates the turn's last user message at admission and tool/output text at the graph seam against `l1.ts`, serves the standalone `POST /v1/sentinel/check` and `GET /v1/sentinel/reports` surfaces, and records metadata-only shadow reports for chat traffic (S4). The chat and voice user advisory is delivered on the managed stream as the `sentinel` SSE frame; the client holds no matcher and no rule bundle. The deterministic JSONL evaluation harness (S3) scores L1 offline. No slice runs an L2 classifier or enforces a verdict on the chat path.

## Rule set

`rules.v1.json` is the canonical v1 artifact. Each rule has a stable `id`, one `category`, one `severity`, `match: "phrase"`, literal `patterns`, and optional `context.requires` / `context.excludes` phrases. Phrase matching normalizes Unicode NFKC, case, punctuation, and whitespace, then requires whole-phrase boundaries. Findings are sorted by rule id; the rule set and policy versions are returned with every verdict.

The current version is `sentinel-rules.v1.0.0`. A rule or policy change requires a new version and corresponding tests. The format intentionally uses only literal phrases so the deterministic evaluator stays reproducible without JavaScript-only regular expressions.

## Rule artifact generation

`server/src/sentinel/rules.v1.json` is the only hand-edited rule source. The generator lives in the Flutter package at `clients/mobile/tool/generate_sentinel_rules.dart`. From the repository root, run:

```sh
dart run clients/mobile/tool/generate_sentinel_rules.dart
```

It emits the server TS artifact `server/src/sentinel/rules.generated.ts` only. The artifact carries the exact source JSON, `sentinel-rules.v1.0.0`, and the source SHA-256. The server test compares the generated source string with the canonical file and pins the hash, so a rule edit without regeneration fails the test suite.

`l1.ts` is the sole evaluator. It normalizes Unicode NFKC, folds case, punctuation, and whitespace, requires whole-phrase boundaries, and applies `context.requires`/`context.excludes`. Findings retain the rule ids, categories, severities, and deterministic rule-id ordering. Only rule metadata leaves the gateway; the evaluated text is not retained in an advisory frame, shadow report, or log.

## Chat and voice advisory

The gateway classifies the turn's last user message at admission on the managed chat and voice (`sendVoiceTurn`) stream paths. When at least one L1 finding is present, it prepends a standalone `sentinel` SSE frame as the stream's first frame:

```json
{
  "sentinel": {
    "advisory": true,
    "phase": "l1",
    "source": "l1",
    "categories": ["jailbreak_attempt"],
    "severity": "high",
    "matchedRules": ["jailbreak_attempt.instruction_override"],
    "findings": [
      {
        "ruleId": "jailbreak_attempt.instruction_override",
        "category": "jailbreak_attempt",
        "severity": "high",
        "source": "l1"
      }
    ],
    "action": { "cannedResponseId": "sentinel_advisory_v1" }
  }
}
```

When the async semantic stage is available it reuses the input shadow report's already-queued evaluation and emits at most one `phase:"semantic"`, `final:true` frame after the streamed deltas and just before the finish chunk/`[DONE]`: `advisory:true` with the semantic `findings` supersedes the provisional L1 frame, and `advisory:false` (with empty decision fields) explicitly clears it. A disabled, unavailable, dropped, or timed-out stage emits no semantic frame, leaving the L1 frame as the fallback; the terminal wait is bounded by `SENTINEL_SEMANTIC_TIMEOUT_MS`. Byte-level framing, field semantics, and old-client degradation are specified in `WIRE_SPEC.md` §3.5 and §7.6–§7.8.

The frame is informational and non-blocking: the turn streams normally and the message is still sent. The client parses it into a dismissible inline chat banner or the existing voice notice line and never sees the evaluated text. A clean turn emits no frame, so its stream is byte-identical to a turn without an advisory. Background JSON submission (`submitBackground`) returns a plain JSON response, not a stream, so it receives no advisory frame; the server-side runner classification described under `## Shadow reporting` still applies. `SENTINEL_POLICY_MODE` remains `advisory` by default and does not enable chat enforcement.

## S3 evaluation

The canonical JSONL corpus is `test/fixtures/sentinel/cases.v1.jsonl`; each non-empty line has:

- `schemaVersion`, stable `id`, `split` (`train`, `dev`, or `test`), `direction`, and BCP-47 `language`.
- Exact `text`, zero or more `{category, severity}` labels, and `expected.decision` plus a sorted category set. S1 currently names its L3 result `verdict`, so the harness uses its `allow | flag | block` values; `quarantine` and `refuse` are accepted as compatibility aliases for `block`.
- `provenance.kind` (`synthetic` or `licensed`), `provenance.license`, and non-sensitive `notes`.

`test/fixtures/sentinel/manifest.v1.json` pins the suite version, minimum counts, threshold, rule hash, and corpus hash. The checked-in corpus is explicitly a **SEED** set (`datasetStatus: seed`), with project-authored synthetic provenance; the safety reviewer/eval owner and the release corpus are still open decisions. The seed minimums are intentionally small and are not the proposed launch corpus size. The seed threshold is `1.0` for deterministic L1 decision accuracy; the release threshold remains an open decision.

Run the offline evaluator from `server`:

```sh
npm run sentinel:eval
# alias: npm run eval:sentinel
```

The CLI reads the JSONL, manifest, and canonical rules locally, runs L1 plus the deterministic S1 L3 policy, and prints one JSON report. It exits `0` when the configurable decision-accuracy threshold passes and `1` when the report fails. The report contains overall decision accuracy, per-category precision/recall/F1 and confusion counts, benign false-positive rate, rule/policy/suite versions, and case ids for failures. It never makes a model or network call and never writes corpus-derived data.

`test/fixtures/sentinel/cases.mutated.v1.jsonl` is a deliberately failing one-case fixture whose expected decision was mutated. To prove threshold failure:

```sh
npm run sentinel:eval -- \
  --cases ../test/fixtures/sentinel/cases.mutated.v1.jsonl \
  --manifest ../test/fixtures/sentinel/manifest.mutated.v1.json
```

That command reports `passed: false` and exits `1`. A release threshold, corpus owner, and reviewer for flagged content remain open product decisions; S3 does not add L2, telemetry, a review queue, or model calls.

## Policy

The current policy is `sentinel-policy.v1.0.0`.

- `SENTINEL_POLICY_MODE=advisory` is the default for the standalone check endpoint. Any non-harmless L1 hit returns `verdict: "flag"`; the request is not rejected.
- `SENTINEL_POLICY_MODE=blocking` is the explicit flip for the standalone check endpoint only. The same hits return `verdict: "block"`; this setting does not enforce chat traffic.
- Chat traffic always uses shadow reporting in S4. Its `verdictWouldBe` is the hypothetical blocking-policy result, and no finding changes the request, tool call, stream, or output.
- No L1 hit returns `verdict: "allow"`.
- `harmless` findings remain allowed.

`SENTINEL_MAX_BODY_BYTES` defaults to `65536`. `SENTINEL_RATE_LIMIT` and `SENTINEL_RATE_BURST` default to `60` and `20`; the limiter is per authenticated owner and process-local, consistent with the single-replica deployment contract.

The severity threshold remains an open product decision. S1 exposes the binary policy mode first so the threshold can be refined without changing the endpoint or rule format.

## Semantic stage (Kev-4B)

The semantic stage is an optional second classifier over the internal Kev-4B decision model. It is **disabled by default** (`SENTINEL_SEMANTIC_ENABLED=false`) and builds no client and makes no model calls when disabled.

When enabled, the gateway resolves `SENTINEL_SEMANTIC_PLUGIN_ID` through the plugin registry **after the plugin store has loaded**. The id must resolve to an installed model plugin whose `inference.mode` is `"decisions"` (the builtin is `kev-4b`, endpoint `http://llama-kev.local:19096`). The decision client is built through the same egress facade as the model path: egress is allowed only for the plugin's own endpoint, and a private/plain-`http:` endpoint is reachable ONLY when its host is admin-vouched in `PLUGINS_TRUSTED_HOSTS` (the same private-range bypass + production `http:` carve-out pairing the facade applies). No raw fetch path is added.

The stage answers one question per Sentinel category in the shadow drain (never on the chat path) and for the standalone `POST /v1/sentinel/check`. When every question answers, the verdict is decided from the semantic findings alone (L1 is not unioned in) while both sources are retained for audit; on any timeout, error, or missing answer — including when the plugin/client could not be constructed at boot — the stage is reported unavailable and both the check and shadow paths fall back to the deterministic L1 findings. A disabled stage records a v2 L1-only report with `semanticAvailable:false`; enabled reports carry the semantic outcome as separate fields.

`SENTINEL_SEMANTIC_THRESHOLD` (0..1, default `0.5`) sets the firing confidence, `SENTINEL_SEMANTIC_CONTEXT_AWARE` (default `true`) selects intent-vs-topical phrasing, and `SENTINEL_SEMANTIC_TIMEOUT_MS` (default `2000`) bounds each decision call. The check and shadow paths share ONE bounded semantic cache (512 entries), keyed on the full text, threshold, phrasing, and model version.

## Shadow reporting (S4)

`SENTINEL_POLICY_MODE` configures the standalone `POST /v1/sentinel/check` surface only. It is **not enforced on chat, tool, or streaming paths**. Chat traffic is classified in shadow mode and records the hypothetical blocking-policy verdict; it is never blocked, cancelled, withheld, or changed. Chat-path enforcement remains deferred until the owner reviews the shadow data.

The gateway classifies the last user message at admission, each redacted and bounded tool result at the graph seam, and the assembled assistant reply post-hoc. Internal chat admission uses the `input` direction even though the public standalone check endpoint continues to reject caller-supplied `direction: "input"` (that endpoint remains for non-input directions). The stateless streaming path classifies the final assembled reply captured at the root `on_chain_end`; no output buffering or withholding is added. Background replies are classified from the same redacted text persisted by the runner.

Each report is metadata-only. It is stored as a dedicated owner-scoped ledger task with `worker: "sentinel"`, a fence-protected `sentinel:shadow` step, `shadow: true`, and terminal status `awaiting_review`; it contains no evaluated text, matched substring, or rule pattern. Reports use the ledger's existing transient retention window (24 hours by default), so this surface is single-replica and is a tuning aid rather than a durable audit archive.

Shadow persistence is serialized through a process-local bounded queue. The request and graph paths classify and enqueue metadata but never await ledger I/O. The queue holds 256 reports, caps each authenticated owner plus `requestId` turn at 32 reports, and uses an explicit `drop-newest` policy. `SentinelShadowReporter.getQueueStats(owner)` exposes queued, accepted, persisted, dropped, turn-cap, queue-cap, and failed counters; `getDroppedCount()` exposes the process total. Queue entries and turn counters are owner-scoped. The queued item retains no evaluated text unless the semantic stage is enabled, in which case it holds the text in memory only until the drain evaluates it; the text is never persisted or logged. `flush()` drains deterministically for shutdown/integration tests; the scheduled immediate otherwise keeps normal process shutdown best-effort and fail-open.

Persistence uses repair rather than a multi-call transaction. A report intent checks the legacy base key and up to eight `:attempt:<n>` keys. A queued partial task is repaired to `cancelled`; a running or stuck partial task is repaired to `failed` using the current fence; a completed `awaiting_review` step is reused. A retry scans attempts in order and returns the first valid completed report, so a one-shot failure cannot leave an active orphan or create a second visible report. Telemetry runs after completion and remains fail-open.

`GET /v1/sentinel/reports` is the owner-scoped tuning surface. It returns aggregate counts and rates for a time window, plus a recent metadata-only page:

```json
{
  "window": { "from": "2026-01-01T00:00:00.000Z", "to": "2026-01-08T00:00:00.000Z" },
  "filters": { "direction": null, "category": null, "severity": null, "verdict": null },
  "summary": {
    "totalReports": 12,
    "turns": 8,
    "byDirection": { "input": 8, "tool_result": 2, "output": 2 },
    "byCategory": { "self_harm": 0, "violence": 0, "illegal": 0, "pii": 0, "child_safety": 0, "sexual_content": 1, "medical_guardrail": 0, "jailbreak_attempt": 1, "harmless": 0 },
    "bySeverity": { "low": 0, "medium": 1, "high": 1 },
    "byVerdictWouldBe": { "allow": 9, "flag": 0, "block": 3 },
    "wouldBlock": 3,
    "ratesPer1000Turns": { "reports": 1500, "wouldBlock": 375 },
    "topRules": [{ "ruleId": "illegal.weapon_or_fraud", "count": 2 }],
    "trendByDay": [{ "date": "2026-01-01", "reports": 5, "wouldBlock": 1 }]
  },
  "reports": [],
  "pagination": { "limit": 50, "offset": 0, "total": 12, "nextOffset": null }
}
```

The `byCategory` and `bySeverity` maps always contain every Sentinel enum key, including zero counts. The default window is the last 30 days. Use `from`, `to` (epoch milliseconds or ISO-8601), `limit` (1–100), `offset`, and optional `direction`, `category`, `severity`, and `verdict` filters. Timestamps must be non-negative safe integers whose `Date` round-trip is exact, remain inside the JavaScript Date range, be no more than five minutes ahead of gateway time, and satisfy `from <= to`; every violation is `400 {"error":"invalid_request"}` rather than a serialization failure. The list uses the v8 owner/worker/status/spec/time-window index and selects only task id, creation time, and the bounded metadata step result. Paging and all aggregate counts run in SQL; `payload` and `job_spec` are never selected. `GET /v1/sentinel/reports/:reportId` returns one owner-scoped report; a cross-owner or unknown id is `404`.

## Endpoint

`POST /v1/sentinel/check` requires the existing `Authorization: Bearer <api-key>` seam. Owner is always derived from the verified key. A supplied `context.taskId` is accepted only when it belongs to that owner. Caller-supplied `owner` fields are rejected, and `direction: "input"` is rejected because input is evaluated server-side at admission rather than through this caller-supplied endpoint. The request field is `text`; `turn` is accepted as a compatibility alias.

Request:

```json
{
  "text": "text to evaluate",
  "direction": "tool_result | output | speak_pass | memory",
  "context": {
    "taskId": "optional ledger task id",
    "plugin": "optional plugin id",
    "subtask": "optional subtask label",
    "recentCategories": ["jailbreak_attempt"]
  }
}
```

Response (`200`):

```json
{
  "mode": "l1_only",
  "verdict": "allow | flag | block",
  "categories": ["jailbreak_attempt"],
  "severity": "high | medium | low | null",
  "matchedRuleIds": ["jailbreak_attempt.instruction_override"],
  "action": { "cannedResponseId": "sentinel_advisory_v1" },
  "requestId": "opaque-sentinel-id",
  "ruleSetVersion": "sentinel-rules.v1.0.0",
  "policyVersion": "sentinel-policy.v1.0.0",
  "ledgerTaskId": "present for flag/block"
}
```

The response never contains the evaluated text or a rule pattern. A `block` verdict is represented in the successful check response; callers enforce that verdict rather than relying on an HTTP error status.

Error responses:

- `401 {"error":"unauthorized"}` for a missing or invalid key.
- `403 {"error":"email_not_verified"}` for an unverified owner.
- `403 {"error":"account_deleted"}` for a tombstoned owner.
- `400 {"error":"invalid_request"}` for malformed input or a caller-supplied owner.
- `400 {"error":"invalid_direction"}` for `input` or an unknown direction.
- `404 {"error":"not_found"}` for a task id not owned by the caller.
- `413 {"error":"request_too_large"}` for an oversized body.
- `429 {"error":"rate_limited"}` with `Retry-After` for the owner limiter.

`GET /v1/sentinel/reports` uses the same key gate. It returns `401 {"error":"unauthorized"}`, `403 {"error":"email_not_verified"}`, `403 {"error":"account_deleted"}`, or `400 {"error":"invalid_request"}` for invalid window/filter parameters. It never returns report content, raw text, or another owner's metadata.

## Ledger record

A `flag` or `block` creates a dedicated owner-scoped ledger task with `worker: "sentinel"`, a metadata-only Sentinel step, and terminal status `awaiting_review`. The step stores request id, direction, L1-only mode, verdict, action id, categories, severity, rule ids, versions, and an optional validated source task id. It never stores the evaluated text or matched pattern. The public ledger completion route cannot select `awaiting_review`; the internal service claims and completes the review task with its fence token.

Shadow reports use the same task/step mechanism and fence protection, with a `shadow: true` marker, `verdictWouldBe`, aggregate/per-finding rule metadata, and the source request/task id. Allow results are recorded too so rates per 1,000 turns are meaningful. The ledger remains a transient 24-hour journal; S4 does not add durable retention or a review queue.

A stored shadow step has this shape (the owner is the ledger task's implicit owner):

```json
{
  "schemaVersion": 1,
  "shadow": true,
  "mode": "l1_only",
  "policyMode": "blocking",
  "direction": "input",
  "categories": ["jailbreak_attempt"],
  "severities": ["high"],
  "ruleIds": ["jailbreak_attempt.instruction_override"],
  "matchedRuleIds": ["jailbreak_attempt.instruction_override"],
  "findings": [{ "ruleId": "jailbreak_attempt.instruction_override", "category": "jailbreak_attempt", "severity": "high" }],
  "severity": "high",
  "verdictWouldBe": "block",
  "policyVersion": "sentinel-policy.v1.0.0",
  "ruleSetVersion": "sentinel-rules.v1.0.0",
  "requestId": "turn-1",
  "taskId": null,
  "sourceTaskId": null,
  "timestamp": "2026-01-08T00:00:00.000Z",
  "ts": 1767820800000
}
```

## Follow-ups

- Enforcement switch: review the shadow data, choose a policy threshold, then add an explicit chat-path enforcement decision; do not infer it from `SENTINEL_POLICY_MODE`.
- Client report view: add a settings-screen view over `GET /v1/sentinel/reports`; no client UI is included in S4.
- Client finding aggregation: a future client may send category/rule ids only (never text) if the delivered advisory and server rates need to be reconciled.
