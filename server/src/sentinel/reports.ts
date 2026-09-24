import type {
  Ledger,
  TaskStepMetadataAggregate,
  TaskStepMetadataFilter,
  TaskStepMetadataQuery,
} from "../ledger.ts";
import {
  SENTINEL_CATEGORIES,
  SENTINEL_SEVERITIES,
  SENTINEL_SHADOW_DIRECTIONS,
  SENTINEL_VERDICTS,
} from "./types.ts";
import type {
  SentinelCategory,
  SentinelSeverity,
  SentinelShadowDirection,
  SentinelVerdictValue,
} from "./types.ts";
import {
  parseSentinelShadowMetadata,
  readSentinelShadowReport,
  SENTINEL_SHADOW_INTENT_PREFIX,
  SENTINEL_SHADOW_DEFAULT_LIMIT,
  SENTINEL_SHADOW_DEFAULT_WINDOW_MS,
  SENTINEL_SHADOW_MAX_LIMIT,
} from "./shadow.ts";
import type { SentinelShadowMetadata, SentinelShadowReport } from "./shadow.ts";

export type SentinelReportQuery = {
  from?: number;
  to?: number;
  limit: number;
  offset: number;
  direction?: SentinelShadowDirection;
  category?: SentinelCategory;
  severity?: SentinelSeverity;
  verdict?: SentinelVerdictValue;
};

export type SentinelReportPage = {
  window: {
    from: string;
    to: string;
  };
  filters: {
    direction: SentinelShadowDirection | null;
    category: SentinelCategory | null;
    severity: SentinelSeverity | null;
    verdict: SentinelVerdictValue | null;
  };
  summary: SentinelReportSummary;
  reports: SentinelShadowReport[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    nextOffset: number | null;
  };
};

export type SentinelReportSummary = {
  totalReports: number;
  turns: number;
  byDirection: Record<SentinelShadowDirection, number>;
  byCategory: Record<SentinelCategory, number>;
  bySeverity: Record<SentinelSeverity, number>;
  byVerdictWouldBe: Record<SentinelVerdictValue, number>;
  wouldBlock: number;
  ratesPer1000Turns: {
    reports: number;
    wouldBlock: number;
  };
  topRules: Array<{ ruleId: string; count: number }>;
  trendByDay: Array<{ date: string; reports: number; wouldBlock: number }>;
};

export const SENTINEL_REPORT_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

type ParsedQuery =
  | { ok: true; value: SentinelReportQuery }
  | { ok: false; code: "invalid_request" };

function validReportTimestamp(value: number, now: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_TIMESTAMP_MS) {
    return false;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() !== value) return false;
  return value <= now + SENTINEL_REPORT_MAX_FUTURE_SKEW_MS;
}

function parseTimestamp(
  value: string | undefined,
  now: number,
): number | null | undefined {
  if (value === undefined || value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return validReportTimestamp(numeric, now) ? numeric : undefined;
  }
  const parsed = Date.parse(value);
  return validReportTimestamp(parsed, now) ? parsed : undefined;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return undefined;
  return parsed;
}

function validDirection(value: string | undefined): SentinelShadowDirection | undefined | null {
  if (value === undefined) return null;
  return SENTINEL_SHADOW_DIRECTIONS.includes(value as SentinelShadowDirection)
    ? (value as SentinelShadowDirection)
    : undefined;
}

function validCategory(value: string | undefined): SentinelCategory | undefined | null {
  if (value === undefined) return null;
  return SENTINEL_CATEGORIES.includes(value as SentinelCategory)
    ? (value as SentinelCategory)
    : undefined;
}

function validSeverity(value: string | undefined): SentinelSeverity | undefined | null {
  if (value === undefined) return null;
  return SENTINEL_SEVERITIES.includes(value as SentinelSeverity)
    ? (value as SentinelSeverity)
    : undefined;
}

function validVerdict(value: string | undefined): SentinelVerdictValue | undefined | null {
  if (value === undefined) return null;
  return SENTINEL_VERDICTS.includes(value as SentinelVerdictValue)
    ? (value as SentinelVerdictValue)
    : undefined;
}

export function parseSentinelReportQuery(
  values: Record<string, string>,
  now = Date.now(),
): ParsedQuery {
  const effectiveNow = Number.isSafeInteger(now) && now >= 0 ? now : Date.now();
  const parsedFrom = parseTimestamp(values.from, effectiveNow);
  const parsedTo = parseTimestamp(values.to, effectiveNow);
  if (parsedFrom === undefined || parsedTo === undefined) return { ok: false, code: "invalid_request" };
  const to = parsedTo ?? effectiveNow;
  const from = parsedFrom ?? Math.max(0, to - SENTINEL_SHADOW_DEFAULT_WINDOW_MS);
  if (from > to) return { ok: false, code: "invalid_request" };
  const limit = parsePositiveInteger(values.limit, SENTINEL_SHADOW_DEFAULT_LIMIT, SENTINEL_SHADOW_MAX_LIMIT);
  const offset = parsePositiveInteger(values.offset, 0, Number.MAX_SAFE_INTEGER);
  if (limit === 0) return { ok: false, code: "invalid_request" };
  const direction = validDirection(values.direction);
  const category = validCategory(values.category);
  const severity = validSeverity(values.severity);
  const verdict = validVerdict(values.verdict ?? values.verdictWouldBe);
  if (
    limit === undefined ||
    offset === undefined ||
    direction === undefined ||
    category === undefined ||
    severity === undefined ||
    verdict === undefined
  ) {
    return { ok: false, code: "invalid_request" };
  }
  return {
    ok: true,
    value: {
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      limit,
      offset,
      ...(direction === null ? {} : { direction }),
      ...(category === null ? {} : { category }),
      ...(severity === null ? {} : { severity }),
      ...(verdict === null ? {} : { verdict }),
    },
  };
}

function zeroByDirection(): Record<SentinelShadowDirection, number> {
  return { input: 0, tool_result: 0, output: 0 };
}

function zeroByCategory(): Record<SentinelCategory, number> {
  return Object.fromEntries(SENTINEL_CATEGORIES.map((category) => [category, 0])) as Record<
    SentinelCategory,
    number
  >;
}

function zeroBySeverity(): Record<SentinelSeverity, number> {
  return Object.fromEntries(SENTINEL_SEVERITIES.map((severity) => [severity, 0])) as Record<
    SentinelSeverity,
    number
  >;
}

function zeroByVerdict(): Record<SentinelVerdictValue, number> {
  return Object.fromEntries(SENTINEL_VERDICTS.map((verdict) => [verdict, 0])) as Record<
    SentinelVerdictValue,
    number
  >;
}

function matchesQuery(
  report: SentinelShadowMetadata,
  query: SentinelReportQuery,
): boolean {
  if (query.from !== undefined && report.ts < query.from) return false;
  if (query.to !== undefined && report.ts > query.to) return false;
  if (query.direction !== undefined && report.direction !== query.direction) return false;
  if (query.category !== undefined && !report.categories.includes(query.category)) return false;
  if (query.severity !== undefined && !report.severities.includes(query.severity)) return false;
  if (query.verdict !== undefined && report.verdictWouldBe !== query.verdict) return false;
  return true;
}

function metadataFilters(query: SentinelReportQuery): TaskStepMetadataFilter[] {
  const filters: TaskStepMetadataFilter[] = [
    { path: "$.schemaVersion", value: 1 },
    { path: "$.shadow", value: 1 },
    { path: "$.mode", value: "l1_only" },
    { path: "$.policyMode", values: ["blocking", "advisory"] },
    {
      path: "$.direction",
      values: query.direction === undefined
        ? SENTINEL_SHADOW_DIRECTIONS
        : [query.direction],
    },
    {
      path: "$.verdictWouldBe",
      values: query.verdict === undefined ? SENTINEL_VERDICTS : [query.verdict],
    },
  ];
  if (query.category !== undefined) {
    filters.push({ path: "$.categories", contains: query.category });
  }
  if (query.severity !== undefined) {
    filters.push({ path: "$.severities", contains: query.severity });
  }
  return filters;
}

function metadataQuery(
  owner: string,
  query: SentinelReportQuery,
): TaskStepMetadataQuery {
  return {
    owner,
    worker: "sentinel",
    status: "awaiting_review",
    specPrefix: SENTINEL_SHADOW_INTENT_PREFIX,
    stage: "sentinel",
    action: "sentinel:shadow",
    from: query.from ?? 0,
    to: query.to ?? MAX_DATE_TIMESTAMP_MS,
    filters: metadataFilters(query),
  };
}

function summarizeAggregate(
  aggregate: TaskStepMetadataAggregate,
  blockedDays: ReadonlyArray<{ value: string; count: number }>,
): SentinelReportSummary {
  const byDirection = zeroByDirection();
  const byCategory = zeroByCategory();
  const bySeverity = zeroBySeverity();
  const byVerdictWouldBe = zeroByVerdict();
  for (const group of aggregate.groups.direction ?? []) {
    if (Object.prototype.hasOwnProperty.call(byDirection, group.value)) {
      byDirection[group.value as SentinelShadowDirection] = group.count;
    }
  }
  for (const group of aggregate.groups.category ?? []) {
    if (Object.prototype.hasOwnProperty.call(byCategory, group.value)) {
      byCategory[group.value as SentinelCategory] = group.count;
    }
  }
  for (const group of aggregate.groups.severity ?? []) {
    if (Object.prototype.hasOwnProperty.call(bySeverity, group.value)) {
      bySeverity[group.value as SentinelSeverity] = group.count;
    }
  }
  for (const group of aggregate.groups.verdict ?? []) {
    if (Object.prototype.hasOwnProperty.call(byVerdictWouldBe, group.value)) {
      byVerdictWouldBe[group.value as SentinelVerdictValue] = group.count;
    }
  }
  const wouldBlock = byVerdictWouldBe.block;
  const dayCounts = new Map(
    (aggregate.groups.day ?? []).map((group) => [
      group.value,
      { reports: group.count, wouldBlock: 0 },
    ]),
  );
  for (const group of blockedDays) {
    const day = dayCounts.get(group.value);
    if (day !== undefined) day.wouldBlock = group.count;
  }
  return {
    totalReports: aggregate.total,
    turns: aggregate.distinct,
    byDirection,
    byCategory,
    bySeverity,
    byVerdictWouldBe,
    wouldBlock,
    ratesPer1000Turns: {
      reports: aggregate.distinct === 0
        ? 0
        : (aggregate.total / aggregate.distinct) * 1_000,
      wouldBlock: aggregate.distinct === 0
        ? 0
        : (wouldBlock / aggregate.distinct) * 1_000,
    },
    topRules: (aggregate.groups.rule ?? []).map((group) => ({
      ruleId: group.value,
      count: group.count,
    })),
    trendByDay: [...dayCounts.entries()]
      .map(([date, counts]) => ({ date, ...counts }))
      .sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export class SentinelReportStore {
  private readonly ledger: Ledger;
  private readonly now: () => number;

  constructor(ledger: Ledger, now: () => number = Date.now) {
    this.ledger = ledger;
    this.now = now;
  }

  list(owner: string, query: SentinelReportQuery): SentinelReportPage {
    const now = this.now();
    const effectiveQuery: SentinelReportQuery = {
      ...query,
      from:
        query.from ??
        Math.max(0, (query.to ?? now) - SENTINEL_SHADOW_DEFAULT_WINDOW_MS),
      to: query.to ?? now,
    };
    const baseQuery = metadataQuery(owner, effectiveQuery);
    const metadataPage = this.ledger.listTaskStepMetadata({
      ...baseQuery,
      limit: effectiveQuery.limit,
      offset: effectiveQuery.offset,
    });
    const aggregate = this.ledger.aggregateTaskStepMetadata(
      baseQuery,
      "$.requestId",
      [
        { key: "direction", path: "$.direction", mode: "value" },
        { key: "category", path: "$.categories", mode: "array_distinct" },
        { key: "severity", path: "$.severities", mode: "array_distinct" },
        { key: "verdict", path: "$.verdictWouldBe", mode: "value" },
        { key: "rule", path: "$.ruleIds", mode: "array_distinct", limit: 20 },
        { key: "day", path: "$.ts", mode: "utc_day" },
      ],
    );
    const blocked = this.ledger.aggregateTaskStepMetadata(
      {
        ...baseQuery,
        filters: [
          ...(baseQuery.filters ?? []),
          { path: "$.verdictWouldBe", value: "block" },
        ],
      },
      "$.requestId",
      [{ key: "day", path: "$.ts", mode: "utc_day" }],
    );
    const reports: SentinelShadowReport[] = [];
    for (const row of metadataPage.rows) {
      try {
        const metadata = parseSentinelShadowMetadata(JSON.parse(row.result) as unknown);
        if (
          metadata === null ||
          !matchesQuery(metadata, effectiveQuery)
        ) {
          continue;
        }
        reports.push({ ...metadata, reportId: row.task_id });
      } catch {
      }
    }
    return {
      window: {
        from: new Date(effectiveQuery.from ?? now).toISOString(),
        to: new Date(effectiveQuery.to ?? now).toISOString(),
      },
      filters: {
        direction: query.direction ?? null,
        category: query.category ?? null,
        severity: query.severity ?? null,
        verdict: query.verdict ?? null,
      },
      summary: summarizeAggregate(aggregate, blocked.groups.day ?? []),
      reports,
      pagination: {
        limit: effectiveQuery.limit,
        offset: effectiveQuery.offset,
        total: metadataPage.total,
        nextOffset:
          effectiveQuery.offset + reports.length < metadataPage.total
            ? effectiveQuery.offset + reports.length
            : null,
      },
    };
  }

  get(owner: string, reportId: string): SentinelReportPage["reports"][number] | null {
    const task = this.ledger.getTask(reportId, owner);
    if (task === null || task.status !== "awaiting_review") return null;
    return readSentinelShadowReport(this.ledger, reportId, owner);
  }
}
