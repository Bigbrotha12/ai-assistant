import { randomUUID } from "node:crypto";
import type { Ledger } from "../ledger.ts";
import { DEFAULT_RULE_SET, evaluateL1 } from "./l1.ts";
import { decideSentinel, DEFAULT_SENTINEL_POLICY } from "./policy.ts";
import { SentinelShadowReporter } from "./shadow.ts";
import type {
  SentinelCheckRequest,
  SentinelCheckResult,
  SentinelPolicy,
  SentinelRuleSet,
  SentinelVerdict,
} from "./types.ts";
import type {
  SentinelShadowInput,
  SentinelShadowWriteResult,
} from "./shadow.ts";
import { SENTINEL_RUNTIME_MODE } from "./types.ts";

export class SentinelTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`task ${taskId} was not found for the authenticated owner`);
    this.name = "SentinelTaskNotFoundError";
  }
}

export type SentinelServiceOptions = {
  ledger: Ledger;
  ruleSet?: SentinelRuleSet;
  policy?: SentinelPolicy;
  requestId?: () => string;
};

export class SentinelService {
  private readonly ledger: Ledger;
  private readonly ruleSet: SentinelRuleSet;
  private readonly policy: SentinelPolicy;
  private readonly requestId: () => string;
  readonly shadow: SentinelShadowReporter;

  constructor(options: SentinelServiceOptions) {
    this.ledger = options.ledger;
    this.ruleSet = options.ruleSet ?? DEFAULT_RULE_SET;
    this.policy = options.policy ?? DEFAULT_SENTINEL_POLICY;
    this.requestId = options.requestId ?? (() => `sentinel_${randomUUID()}`);
    this.shadow = new SentinelShadowReporter({ ledger: this.ledger, ruleSet: this.ruleSet });
  }

  recordShadow(
    owner: string,
    input: Omit<SentinelShadowInput, "owner">,
  ): Promise<SentinelShadowWriteResult | null> {
    return this.shadow.report({ ...input, owner });
  }

  /**
   * SENTINEL_POLICY_MODE configures the standalone check surface only. Chat
   * traffic uses the shadow reporter and is never enforced here.
   */
  check(owner: string, request: SentinelCheckRequest): SentinelCheckResult {
    if (owner.trim() === "") throw new Error("sentinel owner is required");
    const sourceTaskId = request.context?.taskId;
    if (sourceTaskId !== undefined && this.ledger.getTask(sourceTaskId, owner) === null) {
      throw new SentinelTaskNotFoundError(sourceTaskId);
    }
    const findings = evaluateL1(request.text, this.ruleSet);
    const decision = decideSentinel(findings, request, this.policy);
    const requestId = this.requestId();
    const verdict: SentinelVerdict = {
      mode: SENTINEL_RUNTIME_MODE,
      verdict: decision.verdict,
      categories: decision.categories,
      severity: decision.severity,
      matchedRuleIds: decision.matchedRuleIds,
      action: decision.action,
      requestId,
      ruleSetVersion: this.ruleSet.version,
      policyVersion: this.policy.version,
    };
    const ledgerTaskId =
      verdict.verdict === "allow"
        ? null
        : this.recordReview(owner, request, verdict);
    return { verdict, findings, ledgerTaskId };
  }

  private recordReview(
    owner: string,
    request: SentinelCheckRequest,
    verdict: SentinelVerdict,
  ): string {
    const intentKey = `sentinel:${verdict.requestId}`;
    const existing = this.ledger.getTaskByIntentKey(owner, intentKey);
    if (existing) {
      if (existing.status !== "awaiting_review") {
        throw new Error(`sentinel review task ${existing.id} is not awaiting review`);
      }
      return existing.id;
    }
    const task = this.ledger.createTask({
      owner,
      intentKey,
      spec: `sentinel:${request.direction}`,
      worker: "sentinel",
    });
    const claimed = this.ledger.claimTask(task.id, owner);
    const metadata = {
      schemaVersion: 1,
      requestId: verdict.requestId,
      direction: request.direction,
      mode: verdict.mode,
      verdict: verdict.verdict,
      categories: verdict.categories,
      severity: verdict.severity,
      matchedRuleIds: verdict.matchedRuleIds,
      action: verdict.action,
      ruleSetVersion: verdict.ruleSetVersion,
      policyVersion: verdict.policyVersion,
      sourceTaskId: request.context?.taskId ?? null,
    };
    this.ledger.appendStep(
      task.id,
      owner,
      {
        stage: "sentinel",
        action: verdict.verdict === "block" ? "sentinel:block" : "sentinel:flag",
        result: JSON.stringify(metadata),
      },
      claimed.fence_token,
    );
    const review = this.ledger.completeTask(
      task.id,
      owner,
      "awaiting_review",
      claimed.fence_token,
    );
    return review.id;
  }
}

export function createSentinelService(options: SentinelServiceOptions): SentinelService {
  return new SentinelService(options);
}
