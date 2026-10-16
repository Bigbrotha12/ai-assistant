import { randomUUID } from "node:crypto";
import type { Ledger } from "../ledger/index.ts";
import { DEFAULT_RULE_SET, evaluateL1 } from "./l1.ts";
import { decideSentinel, DEFAULT_SENTINEL_POLICY } from "./policy.ts";
import { SentinelShadowReporter } from "./shadow.ts";
import type {
  SentinelCheckRequest,
  SentinelCheckResult,
  SentinelFinding,
  SentinelPolicy,
  SentinelRuleSet,
  SentinelDirection,
  SentinelVerdict,
} from "./types.ts";
import { logger } from "../observability/logger.ts";
import type {
  SentinelShadowInput,
  SentinelShadowSemanticOptions,
  SentinelShadowWriteResult,
} from "./shadow.ts";
import {
  SentinelSemanticCache,
  evaluateSentinelSemanticCached,
  sentinelFindingsForDecision,
} from "./semantic.ts";
import type { SemanticEvaluation } from "./semantic.ts";
import type { DecisionClient } from "../transport/decisions.ts";

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
  /**
   * Semantic stage configuration, forwarded verbatim to the shadow reporter so
   * the standalone check and chat shadow see the same stage. Absent keeps the
   * historical L1-only behavior; `enabled:false` makes no model call.
   */
  semantic?: SentinelShadowSemanticOptions;
};

export class SentinelService {
  private readonly ledger: Ledger;
  private readonly ruleSet: SentinelRuleSet;
  private readonly policy: SentinelPolicy;
  private readonly requestId: () => string;
  private readonly semantic: SentinelShadowSemanticOptions | undefined;
  private readonly semanticClient?: DecisionClient;
  private readonly semanticCache?: SentinelSemanticCache;
  readonly shadow: SentinelShadowReporter;

  constructor(options: SentinelServiceOptions) {
    this.ledger = options.ledger;
    this.ruleSet = options.ruleSet ?? DEFAULT_RULE_SET;
    this.policy = options.policy ?? DEFAULT_SENTINEL_POLICY;
    this.requestId = options.requestId ?? (() => `sentinel_${randomUUID()}`);
    this.semantic = options.semantic;
    if (this.semantic?.enabled === true && this.semantic.evaluate === undefined) {
      this.semanticClient = this.semantic.client;
      this.semanticCache = this.semantic.cache ?? new SentinelSemanticCache();
    }
    this.shadow = new SentinelShadowReporter({
      ledger: this.ledger,
      ruleSet: this.ruleSet,
      semantic: this.semantic === undefined || this.semanticCache === undefined
        ? this.semantic
        : { ...this.semantic, cache: this.semanticCache },
    });
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
   *
   * With the semantic stage enabled and every question answered, the verdict is
   * decided from the semantic findings alone (L1 is not unioned in) while the
   * returned findings keep both sources tagged for audit. Any timeout, error, or
   * missing answer falls back to the L1 findings; `mode` still reports
   * `l1_semantic` because the stage was configured for this check.
   */
  async check(owner: string, request: SentinelCheckRequest): Promise<SentinelCheckResult> {
    if (owner.trim() === "") throw new Error("sentinel owner is required");
    const sourceTaskId = request.context?.taskId;
    if (sourceTaskId !== undefined && this.ledger.getTask(sourceTaskId, owner) === null) {
      throw new SentinelTaskNotFoundError(sourceTaskId);
    }
    const l1Findings = evaluateL1(request.text, this.ruleSet);
    const requestId = this.requestId();
    const semantic = this.semantic?.enabled === true
      ? await this.evaluateSemantic(request.text)
      : undefined;
    if (semantic !== undefined && !semantic.available) {
      this.logSemanticUnavailable(requestId, request.direction, semantic);
    }
    const decisionFindings = semantic === undefined
      ? l1Findings
      : sentinelFindingsForDecision(l1Findings, semantic);
    const decision = decideSentinel(decisionFindings, request, this.policy);
    const verdict: SentinelVerdict = {
      mode: this.semantic?.enabled === true ? "l1_semantic" : "l1_only",
      semanticAvailable: semantic?.available === true,
      verdict: decision.verdict,
      categories: decision.categories,
      severity: decision.severity,
      matchedRuleIds: decision.matchedRuleIds,
      action: decision.action,
      requestId,
      ruleSetVersion: this.ruleSet.version,
      policyVersion: this.policy.version,
    };
    const findings = semantic?.available === true
      ? [...l1Findings, ...semantic.findings]
      : l1Findings;
    const ledgerTaskId =
      verdict.verdict === "allow"
        ? null
        : this.recordReview(owner, request, verdict, findings);
    return { verdict, findings, ledgerTaskId };
  }

  /**
   * Evaluate the semantic stage through the injected seam or the decision
   * client. A thrown evaluator is contained as an L1-fallback unavailable
   * result rather than rejecting the check.
   */
  private async evaluateSemantic(text: string): Promise<SemanticEvaluation> {
    const semantic = this.semantic!;
    try {
      if (semantic.evaluate !== undefined) return await semantic.evaluate(text);
      return await evaluateSentinelSemanticCached(this.semanticClient!, text, {
        threshold: semantic.threshold,
        contextAware: semantic.contextAware,
        modelVersion: semantic.modelVersion,
        cache: this.semanticCache!,
      });
    } catch {
      return { available: false, fallback: "l1", reason: "client_error" };
    }
  }

  /**
   * Log the semantic stage's failure class for the standalone check. Mirrors
   * the shadow reporter's log: requestId/direction/reason/category/modelVersion
   * only — never the evaluated text.
   */
  private logSemanticUnavailable(
    requestId: string,
    direction: SentinelDirection,
    evaluation: SemanticEvaluation,
  ): void {
    if (evaluation.available) return;
    logger.warn("sentinel: semantic stage unavailable; using L1 fallback", {
      requestId,
      direction,
      reason: evaluation.reason,
      failedCategory: evaluation.failedCategory,
      modelVersion: this.semantic?.modelVersion,
    });
  }

  private recordReview(
    owner: string,
    request: SentinelCheckRequest,
    verdict: SentinelVerdict,
    findings: readonly SentinelFinding[],
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
      semanticAvailable: verdict.semanticAvailable,
      verdict: verdict.verdict,
      categories: verdict.categories,
      severity: verdict.severity,
      matchedRuleIds: verdict.matchedRuleIds,
      findings,
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
