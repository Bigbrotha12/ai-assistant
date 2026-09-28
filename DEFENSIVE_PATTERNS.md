# Defensive patterns

Hard-won bug-class rules for the gateway (`server/src`): each is a class of defect that has
shipped or nearly shipped in this stack, stated as the rule that prevents its recurrence.
Read this before writing lifecycle, concurrency, teardown, or egress code, and before adding
a tool-execution or plugin-registration seam. Adapted from upstream DeepSeek Harness
`docs/defensive-patterns.md`, mapped to our code — where we currently violate a pattern, this
says so rather than papering over it.

Verified against `8841130`.

---

## 1. Report orthogonal outcomes independently

**Surface each independent fact on its own; never nest one outcome's report inside another's
branch.** A tool call can be a cache hit *and* carry an error code, or have timed out *and*
been cancelled; a caller that reads one collapsed flag as "clean success" is wrong.

**Why it exists.** Upstream shipped runs that exited `0` because they trapped the timeout
signal: `exitCode` looked clean while `timedOut` was true. Any time two independent facts get
folded into one field, the rarer fact silently disappears.

**Our equivalent (good).** `emitPluginToolAudit` already carries facts side by side rather
than overloading one field — `outcome` (`"ok" | "error" | "timeout" | "cancelled"`),
`errorCode`, `inputBytes`, `outputBytes` (`agents/orchestrator.ts:99-140`,
`jobs/runner.ts:993-1014`). The planned `ToolCallResult` keeps the same discipline with
`outcome` / `errorCode` / `fromCache` / `replayed` as separate fields. Keep it that way; the
thing to avoid is reporting one fact only inside another's branch (e.g. surfacing `replayed`
only when `fromCache === false`).

## 2. Honor public contracts on BOTH sides

**When one outcome has several representations, normalize them before they cross a public
boundary — and exercise every source form through the real consumer.** A caller must not have
to guess whether a caught exception came from the provider, a wrapper, or its own assembly.

**Why it exists.** Upstream `LlmAdapter.stream()` implementations could *throw* or *emit*
`finish {kind:'error'|'aborted'}`; a consumer could only see one. Two representations of one
outcome is a contract that lies on one side.

**Our equivalent (duplicated, being collapsed).** Plugin tool calls normalize success and
throw into one audit emission in two `finally` blocks: `agents/orchestrator.ts:125-140` and
`jobs/runner.ts:1002-1015`. They are copies that must be hand-synced — change one and the
other silently diverges. The plugin-seam pipeline replaces both with one `dispatch` that
settles `onResult` once, on success and on throw (plan §4.1, contract 7). Until then, treat
the pair as a single contract with two implementations.

## 3. Async state is not synchronous state

**A resolved promise does not mean the underlying resource is still valid; re-read mutable
state after the await.** The await orders you against the event you awaited — not against
everything else racing it.

**Why it exists.** Upstream `agent.followup()` had no per-message completion; a job's
completion raced turn boundaries, and `reader.close()` fired for both EOF and disposal.
Treating "the await returned" as "this one operation finished" is wrong in both directions,
and if the awaited transition can never occur the wait hangs.

**Our equivalent (good).** `McpBinding.getClient` awaits `record.clientPromise`, then
re-checks `checkMcpSessionExpiry`, `record.evictionStarted`, and `record.closePromise` before
handing the client back (`agents/mcp.ts:1870-1880`) — because the record can be evicted or
closed *after* the connect promise resolved. Use that shape. The pipeline's `rawSettled`
deferred is the same lesson: a bounded race settling must not be read as the raw body having
settled.

## 4. Dispose must reach quiescence, not just request it

**Teardown must be async and await the work stopping; issuing a close is not the same as being
closed.** A teardown that returns after signalling leaves orphans. Close listener/notification
registries *before* killing children, so late completions stay silent.

**Why it exists.** Upstream killed children and returned before they exited, leaking
processes; it also learned the ordering half the hard way.

**Our equivalent — real gap.** `PluginRegistry.disposeWatch` (`plugins/registry.ts:245-260`)
is synchronous (`void`): it clears the debounce timer, aborts the watch controller, and closes
the watcher — but if `hotReload()` was already invoked from the timer callback
(`plugins/registry.ts:225-232`) that promise is in flight and untracked, so `disposeWatch`
does not await it. Shutdown compounds this: `cleanup` is typed `() => void`
(`index.ts:358`) and the watcher is disposed through it (`index.ts:378`), so shutdown cannot
await a reload either. A reload racing shutdown can leave a dangling mutation of
plugin-store state after shutdown has begun.

**Correction to the plan.** Plan §7 also flags `McpBinding.dispose` as this same gap. It is
not: `disposeBinding` (`agents/mcp.ts:2078-2084`) returns a memoized promise, awaits every
tracked lease's `closeMcpConnection`, and bounds each close with a force-close timer
(`agents/mcp.ts:533-594`). Its residual defect is narrower — closes started *outside* dispose
are detached and escape the barrier: `invalidateCurrent` runs `void closeLease(current)`
(`agents/mcp.ts:1945-1947`), and the connect-failure path runs `void closeMcpConnection(lease)`
after `removeRecord` (`agents/mcp.ts:1936-1941`). `closeAll` awaits only leases still in
`records`, so a dispose racing one of those returns before the close finishes. That is the fix
target, not the dispose method itself.

## 5. Contain callback exceptions in the dispatcher

**A listener that throws must not reject the promise it runs inside or starve the listeners
after it; wrap the dispatch in `try`/`catch` *and log*.**

**Why it exists.** Upstream had a subscriber throw and take the whole dispatch down, so later
listeners never ran.

**Our equivalent — half gap.** `graph.ts` contains both the synchronous throw and the async
rejection from `onToolResult` (`agents/graph.ts:134-148`), so one bad callback does not break
the tool loop — containment is done. But it contains them **silently**: `catch {}` and
`.catch(() => {})` with no log, so a broken audit or progress sink is invisible. The missing
piece is the log. The pipeline's `onResult` must wrap its sink in `try`/`catch` and log (plan
§4.1, contract 7).

## 6. Never hand untrusted output the ambient environment or predictable paths

**Untrusted work gets a scrubbed environment and a private, randomly-named, owner-only path —
never the ambient env or a predictable world-readable name.**

**Why it exists.** Upstream leaked harness credentials into subprocess output and spill files,
and predictable temp paths invited symlink races and disclosure.

**Status: aspirational here.** We run no subprocesses over untrusted input and have no
tool-result temp/spill path yet, so there is nothing to scrub or isolate. The closest
precedent is atomic config persistence, which already uses a random `randomUUID()` suffix,
`0600`, and a same-directory rename (`plugins/store.ts:601-606`, `notify/store.ts:215-220`) —
but that handles *trusted* server config and uses `writeFile`, not an exclusive `'wx'` open.
When tool results spool to disk, this pattern becomes mandatory; it is not a general rule
today.

## 7. Unlink link-shaped paths

**Remove a path that may be a symlink or Windows junction with `lstatSync().isSymbolicLink()`
then `unlinkSync`; reserve recursive `rmSync` for known real directories.**

**Why it exists.** Upstream's recursive delete descended *through* a junction into its target,
and `rmSync(link)` threw `ERR_FS_EISDIR` on Windows junctions. `unlink` deletes only the link.

**Status: aspirational here.** We have no tool-output file removal. The only link-aware code is
skipping dangling symlinks when loading the skills catalog (`catalog/skills.ts:66`), which is
unrelated to deletion. Apply this pattern before reaching for `rm -r` when tool output starts
writing and cleaning up files.
