import { Hono } from "hono";
import { keyGateResponse, requireApiKey } from "../api_key.ts";
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
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);

    const data = catalogs.skills.map(s => ({
      id: s.id,
      title: s.title,
    })).sort((a, b) => a.id.localeCompare(b.id));

    return c.json({ object: "list", data });
  });

  return routes;
}