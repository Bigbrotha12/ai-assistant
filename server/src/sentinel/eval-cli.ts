import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRuleSet } from "./l1.ts";
import {
  evaluateSentinelCases,
  loadSentinelEvalCases,
  parseSentinelEvalManifest,
  validateSentinelEvalManifest,
} from "./eval.ts";
import type { SentinelEvalManifest } from "./eval.ts";

type CliOptions = {
  casesPath: string;
  manifestPath: string;
  rulesPath: string;
  threshold?: number;
};

function usage(): string {
  return [
    "Usage: npm run sentinel:eval -- [--cases PATH] [--manifest PATH] [--rules PATH] [--threshold N]",
    "Runs the deterministic L1 + L3 policy evaluation offline.",
  ].join("\n");
}

function parseArgs(args: readonly string[]): CliOptions {
  const defaults = {
    casesPath: fileURLToPath(new URL("../../../test/fixtures/sentinel/cases.v1.jsonl", import.meta.url)),
    manifestPath: fileURLToPath(new URL("../../../test/fixtures/sentinel/manifest.v1.json", import.meta.url)),
    rulesPath: fileURLToPath(new URL("./rules.v1.json", import.meta.url)),
  } as const;
  let casesPath = defaults.casesPath;
  let manifestPath = defaults.manifestPath;
  let rulesPath = defaults.rulesPath;
  let threshold: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}`);
    }
    if (argument === "--cases") casesPath = value;
    else if (argument === "--manifest") manifestPath = value;
    else if (argument === "--rules") rulesPath = value;
    else if (argument === "--threshold") {
      threshold = Number(value);
      if (!Number.isFinite(threshold)) throw new Error("threshold must be numeric");
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
    index++;
  }
  return {
    casesPath,
    manifestPath,
    rulesPath,
    ...(threshold === undefined ? {} : { threshold }),
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const casesSource = readFileSync(options.casesPath, "utf8");
  const rulesSource = readFileSync(options.rulesPath, "utf8");
  const manifest = parseSentinelEvalManifest(
    JSON.parse(readFileSync(options.manifestPath, "utf8")) as unknown,
  ) as SentinelEvalManifest;
  const cases = loadSentinelEvalCases(casesSource);
  validateSentinelEvalManifest(manifest, cases, {
    casesSource,
    rulesSource,
  });
  const report = evaluateSentinelCases(cases, {
    ruleSet: loadRuleSet(options.rulesPath),
    threshold: options.threshold ?? manifest.thresholds.l1.testDecisionAccuracy,
    suiteVersion: manifest.suiteVersion,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`sentinel eval failed: ${message}\n`);
  process.exitCode = 2;
}
