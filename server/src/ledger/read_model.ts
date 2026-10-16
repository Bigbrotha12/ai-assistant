import type { Database as DatabaseType } from "better-sqlite3";
import {
  LedgerError,
  PUBLIC_RESULT_TRUNCATION_MARKER,
  PUBLIC_STEP_FIELD_MAX_BYTES,
  PUBLIC_STEP_ID_MAX_BYTES,
  PUBLIC_STEP_LIMIT,
  PUBLIC_STEP_RESULT_MAX_BYTES,
  PUBLIC_TASK_PAGE_DEFAULT_LIMIT,
  PUBLIC_TASK_PAGE_MAX_LIMIT,
  TASK_STEP_METADATA_DEFAULT_LIMIT,
  TASK_STEP_METADATA_MAX_LIMIT,
  TASK_STEP_METADATA_MAX_RESULT_CHARS,
} from "./index.ts";
import type {
  ChainRow,
  PublicStepRow,
  PublicStepStats,
  PublicTaskPage,
  PublicTaskRow,
  TaskStepMetadataAggregate,
  TaskStepMetadataAggregateSpec,
  TaskStepMetadataPage,
  TaskStepMetadataPageQuery,
  TaskStepMetadataQuery,
  TaskStepMetadataRow,
} from "./index.ts";

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8ByteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function boundPublicResult(value: string): string {
  if (utf8ByteLength(value) <= PUBLIC_STEP_RESULT_MAX_BYTES) return value;
  const markerBytes = utf8ByteLength(PUBLIC_RESULT_TRUNCATION_MARKER);
  return `${truncateUtf8(
    value,
    PUBLIC_STEP_RESULT_MAX_BYTES - markerBytes,
  )}${PUBLIC_RESULT_TRUNCATION_MARKER}`;
}

export function boundPublicText(value: string, maxBytes: number): string {
  return truncateUtf8(value, maxBytes);
}

function publicLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) return PUBLIC_STEP_LIMIT;
  return Math.min(limit, PUBLIC_STEP_LIMIT);
}

function publicTaskPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return PUBLIC_TASK_PAGE_DEFAULT_LIMIT;
  }
  return Math.min(limit, PUBLIC_TASK_PAGE_MAX_LIMIT);
}

function publicTaskPageOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) return 0;
  return offset;
}

function taskStepMetadataLimit(limit: number | undefined): number {
  if (limit === undefined) return TASK_STEP_METADATA_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    return TASK_STEP_METADATA_DEFAULT_LIMIT;
  }
  return Math.min(limit, TASK_STEP_METADATA_MAX_LIMIT);
}

function taskStepMetadataOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isSafeInteger(offset) || offset < 0) return 0;
  return offset;
}

function metadataPathIsValid(path: string): boolean {
  return path.startsWith("$") && path.length > 1 && !path.includes("\0");
}

export function listPublicTasks(
  db: DatabaseType,
  owner: string,
  limit: number,
  offset: number,
): PublicTaskPage {
  const safeLimit = publicTaskPageLimit(limit);
  const safeOffset = publicTaskPageOffset(offset);
  const rows = db
    .prepare(
      `SELECT id, owner, intent_key, spec, worker, status, created_ts,
              updated_ts, last_heartbeat_ts, lease_expires_at, lease_owner,
              fence_token
       FROM ledger_task
       WHERE owner = ?
       ORDER BY created_ts, id
       LIMIT ? OFFSET ?`,
    )
    .all(owner, safeLimit + 1, safeOffset) as PublicTaskRow[];
  const hasMore = rows.length > safeLimit;
  return {
    tasks: hasMore ? rows.slice(0, safeLimit) : rows,
    nextOffset: hasMore ? safeOffset + safeLimit : null,
  };
}

export function listTaskStepMetadata(
  db: DatabaseType,
  query: TaskStepMetadataPageQuery,
): TaskStepMetadataPage {
  const safeLimit = taskStepMetadataLimit(query.limit);
  const safeOffset = taskStepMetadataOffset(query.offset);
  const source = taskStepMetadataSource(query);
  const totalRow = db
    .prepare(`${source.sql}\nSELECT COUNT(*) AS total FROM report`)
    .get(source.params) as { total: number };
  const pageParams = {
    ...source.params,
    limit: safeLimit + 1,
    offset: safeOffset,
  };
  const rows = db
    .prepare(
      `${source.sql}
       SELECT task_id, created_ts, result
       FROM report
       ORDER BY created_ts DESC, task_id DESC
       LIMIT @limit OFFSET @offset`,
    )
    .all(pageParams) as TaskStepMetadataRow[];
  const hasMore = rows.length > safeLimit;
  const page = hasMore ? rows.slice(0, safeLimit) : rows;
  return {
    rows: page,
    total: Number(totalRow.total),
    nextOffset: hasMore ? safeOffset + page.length : null,
  };
}

export function aggregateTaskStepMetadata(
  db: DatabaseType,
  query: TaskStepMetadataQuery,
  distinctPath: string,
  groups: readonly TaskStepMetadataAggregateSpec[],
): TaskStepMetadataAggregate {
  if (!metadataPathIsValid(distinctPath)) {
    throw new LedgerError("INVALID_CONFIG", "distinct metadata path is invalid");
  }
  const source = taskStepMetadataSource(query);
  const totals = db
    .prepare(
      `${source.sql}
       SELECT COUNT(*) AS total,
              COUNT(DISTINCT json_extract(result, @distinctPath)) AS distinctCount
       FROM report`,
    )
    .get({ ...source.params, distinctPath }) as {
    total: number;
    distinctCount: number;
  };
  const grouped: TaskStepMetadataAggregate["groups"] = {};
  for (const group of groups) {
    if (
      !metadataPathIsValid(group.path) ||
      (group.mode !== "value" &&
        group.mode !== "array_distinct" &&
        group.mode !== "utc_day")
    ) {
      throw new LedgerError("INVALID_CONFIG", "metadata aggregate spec is invalid");
    }
    const groupLimit =
      group.limit === undefined ||
      !Number.isSafeInteger(group.limit) ||
      group.limit <= 0
        ? TASK_STEP_METADATA_MAX_LIMIT
        : Math.min(group.limit, TASK_STEP_METADATA_MAX_LIMIT);
    const groupParams = {
      ...source.params,
      path: group.path,
      groupLimit,
    };
    let sql: string;
    if (group.mode === "array_distinct") {
      sql = `${source.sql}
        SELECT value, COUNT(*) AS count
        FROM (
          SELECT DISTINCT report.task_id, CAST(item.value AS TEXT) AS value
          FROM report
          JOIN json_each(report.result, @path) AS item
          WHERE item.value IS NOT NULL
        ) AS distinct_values
        GROUP BY value
        ORDER BY count DESC, value ASC
        LIMIT @groupLimit`;
    } else {
      const expression =
        group.mode === "utc_day"
          ? "date(CAST(json_extract(report.result, @path) AS INTEGER) / 1000, 'unixepoch')"
          : "CAST(json_extract(report.result, @path) AS TEXT)";
      sql = `${source.sql}
        SELECT ${expression} AS value, COUNT(*) AS count
        FROM report
        WHERE ${expression} IS NOT NULL
        GROUP BY value
        ORDER BY count DESC, value ASC
        LIMIT @groupLimit`;
    }
    grouped[group.key] = db.prepare(sql).all(groupParams) as Array<{
      value: string;
      count: number;
    }>;
  }
  return {
    total: Number(totals.total),
    distinct: Number(totals.distinctCount),
    groups: grouped,
  };
}

export function taskStepMetadataSource(query: TaskStepMetadataQuery): {
  sql: string;
  params: Record<string, string | number | boolean>;
} {
  if (
    query.owner.trim() === "" ||
    query.worker.trim() === "" ||
    query.specPrefix === "" ||
    query.stage === "" ||
    query.action === "" ||
    !Number.isSafeInteger(query.from) ||
    !Number.isSafeInteger(query.to) ||
    query.from < 0 ||
    query.from > query.to
  ) {
    throw new LedgerError("INVALID_CONFIG", "task step metadata query is invalid");
  }
  const params: Record<string, string | number | boolean> = {
    owner: query.owner,
    worker: query.worker,
    status: query.status,
    specPrefix: query.specPrefix,
    specPrefixUpper: `${query.specPrefix}\uffff`,
    stage: query.stage,
    action: query.action,
    from: query.from,
    to: query.to,
    resultLimit: TASK_STEP_METADATA_MAX_RESULT_CHARS,
  };
  const filterClauses: string[] = [];
  for (const [index, filter] of (query.filters ?? []).entries()) {
    if (!metadataPathIsValid(filter.path)) {
      throw new LedgerError("INVALID_CONFIG", "task step metadata filter is invalid");
    }
    if ("value" in filter) {
      const key = `filterPath${index}`;
      const valueKey = `filterValue${index}`;
      params[key] = filter.path;
      params[valueKey] = filter.value;
      filterClauses.push(
        `json_extract(result, @${key}) = @${valueKey}`,
      );
    } else if ("values" in filter) {
      if (filter.values.length === 0) {
        filterClauses.push("0 = 1");
        continue;
      }
      const key = `filterPath${index}`;
      params[key] = filter.path;
      const placeholders = filter.values.map((_, valueIndex) => {
        const valueKey = `filterValue${index}_${valueIndex}`;
        params[valueKey] = filter.values[valueIndex]!;
        return `@${valueKey}`;
      });
      filterClauses.push(
        `json_extract(result, @${key}) IN (${placeholders.join(", ")})`,
      );
    } else {
      const pathKey = `filterPath${index}`;
      const valueKey = `filterValue${index}`;
      params[pathKey] = filter.path;
      params[valueKey] = filter.contains;
      filterClauses.push(
        `EXISTS (
          SELECT 1 FROM json_each(result, @${pathKey}) AS filter_item
          WHERE filter_item.value = @${valueKey}
        )`,
      );
    }
  }
  return {
    sql: `WITH candidates AS (
      SELECT t.id AS task_id,
             t.created_ts AS created_ts,
             substr(s.result, 1, @resultLimit) AS result
      FROM ledger_task AS t
      JOIN ledger_step AS s
        ON s.task_id = t.id
       AND s.seq = (
         SELECT MIN(previous.seq)
         FROM ledger_step AS previous
         WHERE previous.task_id = t.id
           AND previous.stage = @stage
           AND previous.action = @action
           AND previous.result IS NOT NULL
           AND json_valid(substr(previous.result, 1, @resultLimit)) = 1
       )
      WHERE t.worker = @worker
        AND t.owner = @owner
        AND t.status = @status
        AND t.spec >= @specPrefix
        AND t.spec < @specPrefixUpper
        AND t.created_ts >= @from
        AND t.created_ts <= @to
    ),
    report AS (
      SELECT task_id, created_ts, result
      FROM candidates
      WHERE json_valid(result) = 1
        ${filterClauses.length === 0 ? "" : `AND ${filterClauses.join("\n        AND ")}`}
    )`,
    params,
  };
}

export function listPublicSteps(
  db: DatabaseType,
  taskId: string,
  limit: number,
): PublicStepRow[] {
  const safeLimit = publicLimit(limit);
  const rows = db
    .prepare(
      `SELECT substr(id, 1, ?) AS id,
              substr(task_id, 1, ?) AS task_id,
              seq,
              substr(stage, 1, ?) AS stage,
              substr(action, 1, ?) AS action,
              CASE WHEN result IS NULL THEN NULL ELSE substr(result, 1, ?) END AS result,
              ts,
              CASE WHEN tool_call_id IS NULL THEN NULL ELSE substr(tool_call_id, 1, ?) END AS tool_call_id,
              CASE WHEN result IS NULL THEN 0 ELSE length(CAST(result AS BLOB)) END AS resultBytes
       FROM ledger_step
       WHERE task_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(
      PUBLIC_STEP_ID_MAX_BYTES,
      PUBLIC_STEP_ID_MAX_BYTES,
      PUBLIC_STEP_FIELD_MAX_BYTES,
      PUBLIC_STEP_FIELD_MAX_BYTES,
      PUBLIC_STEP_RESULT_MAX_BYTES,
      PUBLIC_STEP_ID_MAX_BYTES,
      taskId,
      safeLimit,
    ) as PublicStepRow[];
  return rows.reverse().map((step) => ({
    ...step,
    id: boundPublicText(step.id, PUBLIC_STEP_ID_MAX_BYTES),
    task_id: boundPublicText(step.task_id, PUBLIC_STEP_ID_MAX_BYTES),
    stage: boundPublicText(step.stage, PUBLIC_STEP_FIELD_MAX_BYTES),
    action: boundPublicText(step.action, PUBLIC_STEP_FIELD_MAX_BYTES),
    result: step.result === null ? null : boundPublicResult(step.result),
    tool_call_id:
      step.tool_call_id === null
        ? null
        : boundPublicText(step.tool_call_id, PUBLIC_STEP_ID_MAX_BYTES),
  }));
}

export function getPublicStepStats(
  db: DatabaseType,
  taskId: string,
): PublicStepStats {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS stepCount,
              COALESCE(SUM(
                CASE WHEN result IS NULL THEN 0
                     ELSE length(CAST(result AS BLOB)) END
              ), 0) AS resultBytes,
              (
                SELECT substr(action, 1, ?)
                FROM ledger_step
                WHERE task_id = ? AND stage = 'error' AND substr(action, 1, 6) = 'error:'
                ORDER BY seq DESC
                LIMIT 1
              ) AS lastErrorAction
       FROM ledger_step
       WHERE task_id = ?`,
    )
    .get(PUBLIC_STEP_FIELD_MAX_BYTES, taskId, taskId) as unknown as {
    stepCount: number;
    resultBytes: number;
    lastErrorAction: string | null;
  };
  const lastErrorCode =
    typeof row.lastErrorAction === "string" &&
    row.lastErrorAction.startsWith("error:")
      ? row.lastErrorAction.slice("error:".length)
      : undefined;
  return {
    stepCount: Number(row.stepCount),
    resultBytes: Number(row.resultBytes),
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
  };
}

export function readPublicChain(
  db: DatabaseType,
  taskId: string,
  limit: number,
): ChainRow[] {
  const safeLimit = publicLimit(limit);
  const rows = db
    .prepare(
      `SELECT seq,
              substr(task_id, 1, ?) AS task_id,
              substr(step_id, 1, ?) AS step_id,
              substr(digest, 1, ?) AS digest,
              CASE WHEN prev_digest IS NULL THEN NULL ELSE substr(prev_digest, 1, ?) END AS prev_digest,
              ts
       FROM ledger_chain
       WHERE task_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .all(
      PUBLIC_STEP_ID_MAX_BYTES,
      PUBLIC_STEP_ID_MAX_BYTES,
      PUBLIC_STEP_ID_MAX_BYTES,
      PUBLIC_STEP_ID_MAX_BYTES,
      taskId,
      safeLimit,
    ) as ChainRow[];
  return rows.reverse().map((record) => ({
    ...record,
    task_id: boundPublicText(record.task_id, PUBLIC_STEP_ID_MAX_BYTES),
    step_id: boundPublicText(record.step_id, PUBLIC_STEP_ID_MAX_BYTES),
    digest: boundPublicText(record.digest, PUBLIC_STEP_ID_MAX_BYTES),
    prev_digest:
      record.prev_digest === null
        ? null
        : boundPublicText(record.prev_digest, PUBLIC_STEP_ID_MAX_BYTES),
  }));
}
