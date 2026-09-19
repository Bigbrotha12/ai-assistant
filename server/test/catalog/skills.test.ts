import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadSkillsCatalog } from "../../src/catalog/skills.ts";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "skills-catalog-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SKILL_A = `---
id: mealie
title: Mealie Skills
---
# Mealie
Recipe management skills.`;

const SKILL_B = `---
id: vikunja
title: Vikunja Skills
---
# Vikunja
Task management skills.`;

describe("loadSkillsCatalog", () => {
  test("happy path: two SKILL.md files with frontmatter", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "mealie"), { recursive: true });
      await mkdir(join(dir, "vikunja"), { recursive: true });
      await writeFile(join(dir, "mealie", "SKILL.md"), SKILL_A);
      await writeFile(join(dir, "vikunja", "SKILL.md"), SKILL_B);

      const result = await loadSkillsCatalog(dir);
      assert.equal(result.length, 2);
      assert.equal(result[0]!.id, "mealie");
      assert.equal(result[0]!.title, "Mealie Skills");
      assert.ok(result[0]!.content.includes("Recipe management"));
      assert.equal(result[1]!.id, "vikunja");
      assert.equal(result[1]!.title, "Vikunja Skills");
      assert.ok(result[1]!.content.includes("Task management"));
    });
  });

  test("no frontmatter: id and title derived from dir name", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "my-skill-dir"), { recursive: true });
      await writeFile(join(dir, "my-skill-dir", "SKILL.md"), "Just content.");

      const result = await loadSkillsCatalog(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.id, "my-skill-dir");
      assert.equal(result[0]!.title, "my-skill-dir");
      assert.equal(result[0]!.content, "Just content.");
    });
  });

  test("collision: duplicate ids throw", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "a"), { recursive: true });
      await mkdir(join(dir, "b"), { recursive: true });
      await writeFile(
        join(dir, "a", "SKILL.md"),
        "---\nid: dup\n---\nContent A",
      );
      await writeFile(
        join(dir, "b", "SKILL.md"),
        "---\nid: dup\n---\nContent B",
      );

      await assert.rejects(
        () => loadSkillsCatalog(dir),
        (err: unknown) =>
          err instanceof Error && err.message.includes("dup"),
      );
    });
  });

  test("missing dir returns empty array", async () => {
    const result = await loadSkillsCatalog(
      join(tmpdir(), "nonexistent-catalog-dir-" + Date.now()),
    );
    assert.deepEqual(result, []);
  });

  test("invalid id in frontmatter throws", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "bad"), { recursive: true });
      await writeFile(
        join(dir, "bad", "SKILL.md"),
        "---\nid: Has Spaces\n---\nBad id",
      );

      await assert.rejects(
        () => loadSkillsCatalog(dir),
        (err: unknown) =>
          err instanceof Error && err.message.includes("Has Spaces"),
      );
    });
  });

  test("dangling symlink is skipped with warning", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...msgs: unknown[]) => {
      warnings.push(msgs.join(" "));
    };
    try {
      await withDir(async (dir) => {
        await symlink(
          join(dir, "does-not-exist"),
          join(dir, "SKILL.md"),
        );
        await mkdir(join(dir, "ok"), { recursive: true });
        await writeFile(
          join(dir, "ok", "SKILL.md"),
          "---\nid: ok-skill\n---\nGood",
        );

        const result = await loadSkillsCatalog(dir);
        assert.equal(result.length, 1);
        assert.equal(result[0]!.id, "ok-skill");
        assert.ok(
          warnings.some((w) => w.includes("Dangling")),
        );
      });
    } finally {
      console.warn = origWarn;
    }
  });

  test("symlink cycle: same realpath deduplicated", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, "real"), { recursive: true });
      await writeFile(
        join(dir, "real", "SKILL.md"),
        "---\nid: real-one\n---\nReal skill",
      );
      await mkdir(join(dir, "link"), { recursive: true });
      await symlink(
        join(dir, "real", "SKILL.md"),
        join(dir, "link", "SKILL.md"),
      );

      const result = await loadSkillsCatalog(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.id, "real-one");
    });
  });

  test("hidden directory is skipped", async () => {
    await withDir(async (dir) => {
      await mkdir(join(dir, ".hidden"), { recursive: true });
      await writeFile(
        join(dir, ".hidden", "SKILL.md"),
        "---\nid: should-not-appear\n---\nHidden",
      );
      await mkdir(join(dir, "visible"), { recursive: true });
      await writeFile(
        join(dir, "visible", "SKILL.md"),
        "---\nid: visible-one\n---\nVisible",
      );

      const result = await loadSkillsCatalog(dir);
      assert.equal(result.length, 1);
      assert.equal(result[0]!.id, "visible-one");
    });
  });
});