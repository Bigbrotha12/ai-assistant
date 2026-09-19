import { Hono } from "hono";
import { requireApiKey, unauthorized } from "../inference.ts";
import type { Catalogs } from "../catalog/index.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";

export type SkillsRoutesOptions = {
  catalogs: Catalogs;
  verifyKey?: VerifyApiKeyFn;
};

export function createSkillsRoutes(opts: SkillsRoutesOptions): Hono {
  const { catalogs } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono();

  routes.get("/skills", async (c) => {
    const owner = await verifyKey(c);
    if (!owner) return unauthorized(c);

    const data = catalogs.skills.map(s => ({
      id: s.id,
      title: s.title,
    })).sort((a, b) => a.id.localeCompare(b.id));

    return c.json({ object: "list", data });
  });

  return routes;
}