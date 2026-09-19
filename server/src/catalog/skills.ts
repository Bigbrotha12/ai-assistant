import { glob, readFile, realpath } from "node:fs/promises";
import { join, parse } from "node:path";
import { logger } from "../logger.ts";
import { pluginIdSchema } from "../plugins/types.ts";

export type SkillEntry = {
  id: string;
  title: string;
  content: string;
};

function toKebab(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseFrontmatter(text: string): {
  id?: string;
  title?: string;
  body: string;
  hasFrontmatter: boolean;
} {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { body: text, hasFrontmatter: false };
  }
  const endIndex = lines.findIndex(
    (line, i) => i > 0 && line.trim() === "---",
  );
  if (endIndex === -1) {
    return { body: text, hasFrontmatter: false };
  }
  const headers: Record<string, string> = {};
  for (let i = 1; i < endIndex; i++) {
    const match = lines[i]!.match(/^(\w+):\s*(.*)/);
    if (match) {
      headers[match[1]!] = match[2]!.trim();
    }
  }
  const body = lines.slice(endIndex + 1).join("\n").trim();
  return {
    id: headers["id"],
    title: headers["title"],
    body,
    hasFrontmatter: true,
  };
}

export async function loadSkillsCatalog(
  dir: string,
): Promise<SkillEntry[]> {
  const visited = new Set<string>();
  const entries: SkillEntry[] = [];
  const seenIds = new Map<string, string>();

  const gen = glob("**/SKILL.md", { cwd: dir });
  for await (const file of gen) {
    const fullPath = join(dir, file);

    let resolved: string;
    try {
      resolved = await realpath(fullPath);
    } catch {
      logger.warn(`Dangling symlink skipped: ${fullPath}`);
      continue;
    }

    if (visited.has(resolved)) {
      continue;
    }
    visited.add(resolved);

    const text = await readFile(fullPath, "utf-8");
    const parts = parse(file);
    const dirName = parts.dir
      ? parts.dir.split("/").pop()!
      : parts.name;

    const fm = parseFrontmatter(text);
    const id = fm.id ?? toKebab(dirName);
    const title = fm.title ?? dirName;
    const content = fm.hasFrontmatter ? fm.body : text;

    const idResult = pluginIdSchema.safeParse(id);
    if (!idResult.success) {
      throw new Error(
        `Invalid skill id '${id}' in ${fullPath}: must be lowercase kebab-case`,
      );
    }

    const existing = seenIds.get(id);
    if (existing) {
      throw new Error(
        `Duplicate skill id '${id}' in ${existing} and ${fullPath}`,
      );
    }
    seenIds.set(id, fullPath);

    entries.push({ id, title, content });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}