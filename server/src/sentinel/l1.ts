import { readFileSync } from "node:fs";
import { isRecord } from "../util.ts";
import {
  SENTINEL_CATEGORIES,
  SENTINEL_SCHEMA_VERSION,
  SENTINEL_SEVERITIES,
} from "./types.ts";
import type {
  L1Finding,
  SentinelCategory,
  SentinelRule,
  SentinelRuleContext,
  SentinelRuleSet,
  SentinelSeverity,
} from "./types.ts";

export class SentinelRuleSetError extends Error {
  readonly code: "INVALID_RULE_SET";

  constructor(message: string) {
    super(message);
    this.name = "SentinelRuleSetError";
    this.code = "INVALID_RULE_SET";
  }
}

function stringList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SentinelRuleSetError(`${path} must be a non-empty array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SentinelRuleSetError(`${path}[${index}] must be a non-empty string`);
    }
    return entry;
  });
}

function optionalStringList(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  return stringList(value, path);
}

function parseContext(value: unknown, path: string): SentinelRuleContext | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new SentinelRuleSetError(`${path} must be an object`);
  }
  return {
    requires: optionalStringList(value.requires, `${path}.requires`),
    excludes: optionalStringList(value.excludes, `${path}.excludes`),
  };
}

function parseRule(value: unknown, index: number): SentinelRule {
  const path = `rules[${index}]`;
  if (!isRecord(value)) {
    throw new SentinelRuleSetError(`${path} must be an object`);
  }
  const id = value.id;
  const category = value.category;
  const severity = value.severity;
  if (typeof id !== "string" || id.trim() === "") {
    throw new SentinelRuleSetError(`${path}.id must be a non-empty string`);
  }
  if (typeof category !== "string" || !SENTINEL_CATEGORIES.includes(category as SentinelCategory)) {
    throw new SentinelRuleSetError(`${path}.category is unknown`);
  }
  if (typeof severity !== "string" || !SENTINEL_SEVERITIES.includes(severity as SentinelSeverity)) {
    throw new SentinelRuleSetError(`${path}.severity is unknown`);
  }
  if (value.match !== undefined && value.match !== "phrase") {
    throw new SentinelRuleSetError(`${path}.match must be phrase`);
  }
  const context = parseContext(value.context, `${path}.context`);
  return {
    id,
    category: category as SentinelCategory,
    severity: severity as SentinelSeverity,
    match: "phrase",
    patterns: stringList(value.patterns, `${path}.patterns`),
    context,
  };
}

export function parseRuleSet(value: unknown): SentinelRuleSet {
  if (!isRecord(value)) {
    throw new SentinelRuleSetError("rule set must be an object");
  }
  if (value.schemaVersion !== SENTINEL_SCHEMA_VERSION) {
    throw new SentinelRuleSetError("unsupported rule set schema version");
  }
  if (typeof value.version !== "string" || value.version.trim() === "") {
    throw new SentinelRuleSetError("rule set version must be a non-empty string");
  }
  if (!Array.isArray(value.rules)) {
    throw new SentinelRuleSetError("rules must be an array");
  }
  const seen = new Set<string>();
  const rules = value.rules.map((rule, index) => {
    const parsed = parseRule(rule, index);
    if (seen.has(parsed.id)) {
      throw new SentinelRuleSetError(`duplicate rule id ${parsed.id}`);
    }
    seen.add(parsed.id);
    return parsed;
  });
  return { schemaVersion: SENTINEL_SCHEMA_VERSION, version: value.version, rules };
}

export function normalizeSentinelText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character);
}

export function containsNormalizedPhrase(text: string, phrase: string): boolean {
  const normalizedText = normalizeSentinelText(text);
  const normalizedPhrase = normalizeSentinelText(phrase);
  if (normalizedPhrase === "") return false;
  let offset = 0;
  while (offset <= normalizedText.length) {
    const found = normalizedText.indexOf(normalizedPhrase, offset);
    if (found === -1) return false;
    const before = found === 0 ? undefined : normalizedText[found - 1];
    const afterIndex = found + normalizedPhrase.length;
    const after = afterIndex >= normalizedText.length ? undefined : normalizedText[afterIndex];
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = found + 1;
  }
  return false;
}

function ruleMatches(rule: SentinelRule, text: string): boolean {
  if (!rule.patterns.some((pattern) => containsNormalizedPhrase(text, pattern))) return false;
  if (rule.context?.requires && !rule.context.requires.every((phrase) => containsNormalizedPhrase(text, phrase))) {
    return false;
  }
  if (rule.context?.excludes?.some((phrase) => containsNormalizedPhrase(text, phrase))) {
    return false;
  }
  return true;
}

export function evaluateL1(
  text: string,
  ruleSet: SentinelRuleSet = loadRuleSet(),
): L1Finding[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  return ruleSet.rules
    .filter((rule) => ruleMatches(rule, text))
    .map((rule) => ({
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
    }))
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

export function loadRuleSet(
  path: string | URL = new URL("./rules.v1.json", import.meta.url),
): SentinelRuleSet {
  return parseRuleSet(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

export const DEFAULT_RULE_SET: SentinelRuleSet = loadRuleSet();
export const SENTINEL_RULE_SET = DEFAULT_RULE_SET;
export const evaluateRules = evaluateL1;
