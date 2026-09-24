import { createHash } from "node:crypto";
import { pluginDefinitionSchema } from "./types.ts";
import type { PluginDefinition } from "./types.ts";

export const MANIFEST_DIGEST_VERSION = 1;
export const MANIFEST_DIGEST_PREFIX = `sha256:v${MANIFEST_DIGEST_VERSION}:`;

export function canonicalManifestJson(input: unknown): string {
  const definition = pluginDefinitionSchema.parse(input) as PluginDefinition;
  return JSON.stringify(canonicalize(definition));
}

export function computeManifestDigest(input: unknown): string {
  const canonical = canonicalManifestJson(input);
  const digest = createHash("sha256")
    .update(`plugin-manifest:v${MANIFEST_DIGEST_VERSION}\n${canonical}`, "utf8")
    .digest("hex");
  return `${MANIFEST_DIGEST_PREFIX}${digest}`;
}

export function isSupportedManifestDigest(value: string): boolean {
  return new RegExp(`^${MANIFEST_DIGEST_PREFIX}[0-9a-f]{64}$`).test(value);
}

export const computeManifestHash = computeManifestDigest;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    const child = canonicalize(record[key]);
    if (child !== undefined) sorted[key] = child;
  }
  return sorted;
}
