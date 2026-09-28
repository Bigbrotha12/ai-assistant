/**
 * Job error primitives — extracted from `jobs/runner.ts` into a leaf module so
 * the tool-pipeline interceptors (`fence`, `replay`) can raise them without
 * importing `runner.ts`.
 *
 * Phase 1.9 makes `runner.ts` import the pipeline; importing `JobError` from
 * `runner.ts` in the interceptors would close the cycle
 * `runner → pipeline → interceptors → runner`. `runner.ts` re-exports these so
 * every existing importer (`index.ts`, tests) is unaffected.
 */

/** Job error codes surfaced to callers and recorded as ledger steps. */
export type JobErrorCode =
  | "credentials_expired"
  | "task_conflict"
  | "plugin_unavailable"
  | "job_failed"
  | "tool_retry_forbidden"
  | "budget_exhausted"
  | "context_length_exceeded"
  | "account_deleted";

/** Raised by the job runner / tool executor. Never carries credential values. */
export class JobError extends Error {
  readonly code: JobErrorCode;

  constructor(code: JobErrorCode, message: string) {
    super(message);
    this.name = "JobError";
    this.code = code;
  }
}
