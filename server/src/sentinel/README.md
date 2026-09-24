# Sentinel S1–S3

S1 is the gateway-side deterministic Sentinel backbone. S2 adds the offline on-device input preflight, and S3 adds the deterministic JSONL evaluation harness. None of these slices runs an L2 classifier, changes the server policy default, or adds a second network check for client input.

## Rule set

`rules.v1.json` is the canonical v1 artifact. Each rule has a stable `id`, one `category`, one `severity`, `match: "phrase"`, literal `patterns`, and optional `context.requires` / `context.excludes` phrases. Phrase matching normalizes Unicode NFKC, case, punctuation, and whitespace, then requires whole-phrase boundaries. Findings are sorted by rule id; the rule set and policy versions are returned with every verdict.

The current version is `sentinel-rules.v1.0.0`. A rule or policy change requires a new version and corresponding tests. The format intentionally uses only literal phrases so the on-device implementation can reproduce it without JavaScript-only regular expressions.

## Shared rule bundle (S2)

`server/src/sentinel/rules.v1.json` remains the only hand-edited rule source. From the repository root, run:

```sh
dart run tool/generate_sentinel_rules.dart
```

The generator emits `server/src/sentinel/rules.generated.ts` and `lib/features/sentinel/data/rules.generated.dart`. Both artifacts contain the exact source JSON, `sentinel-rules.v1.0.0`, and the source SHA-256. The Dart bundle is compiled into the app; S2 does not fetch rules or call `/v1/sentinel/check` before sending. The server and Dart tests compare each generated source string with the canonical file and pin the hash, so a rule edit without regeneration fails the test suite.

The Dart evaluator uses the same literal phrase model as `l1.ts`: NFKC-compatible normalization, case folding, punctuation/whitespace folding, whole-phrase boundaries, and `context.requires`/`context.excludes` checks. Findings retain the server rule ids, categories, severities, and deterministic rule-id ordering. Only rule metadata is exposed to the advisory UI; outgoing text is not retained in an advisory object or log.

## Client advisory (S2)

`ManagedConversationService.sendTurn` runs the local gate before admission and before the managed request. Text chat and the voice transcript path both use that synchronous send path. S2 is advisory and non-blocking: a high- or medium-severity finding displays a dismissible inline chat banner (or the existing voice notice line), then the message is still sent. A gate failure is fail-open for the send and does not create a server request. `SENTINEL_POLICY_MODE` remains `advisory` by default; the server environment setting is unchanged. Background submission is left to the later M4 remainder rather than adding a second client send-path seam in S2.

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

- `SENTINEL_POLICY_MODE=advisory` is the default. Any non-harmless L1 hit returns `verdict: "flag"`; the request is not rejected.
- `SENTINEL_POLICY_MODE=blocking` is the explicit flip. The same hits return `verdict: "block"`.
- No L1 hit returns `verdict: "allow"`.
- `harmless` findings remain allowed.

`SENTINEL_MAX_BODY_BYTES` defaults to `65536`. `SENTINEL_RATE_LIMIT` and `SENTINEL_RATE_BURST` default to `60` and `20`; the limiter is per authenticated owner and process-local, consistent with the single-replica deployment contract.

The severity threshold remains an open product decision. S1 exposes the binary policy mode first so the threshold can be refined without changing the endpoint or rule format.

## Endpoint

`POST /v1/sentinel/check` requires the existing `Authorization: Bearer <api-key>` seam. Owner is always derived from the verified key. A supplied `context.taskId` is accepted only when it belongs to that owner. Caller-supplied `owner` fields are rejected, and `direction: "input"` is rejected because input runs on-device in S2. The request field is `text`; `turn` is accepted as a compatibility alias.

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

## Ledger record

A `flag` or `block` creates a dedicated owner-scoped ledger task with `worker: "sentinel"`, a metadata-only Sentinel step, and terminal status `awaiting_review`. The step stores request id, direction, L1-only mode, verdict, action id, categories, severity, rule ids, versions, and an optional validated source task id. It never stores the evaluated text or matched pattern. The public ledger completion route cannot select `awaiting_review`; the internal service claims and completes the review task with its fence token.

The ledger remains a transient 24-hour journal. S1 does not add durable retention or a review queue; review authority, resolution, and retention remain open decisions for S5.
