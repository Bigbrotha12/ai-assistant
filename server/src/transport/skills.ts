import { Hono } from "hono";
import { requireApiKey, requireOwner } from "../auth/request_auth.ts";
import type { OwnerVariables, VerifyApiKeyFn } from "../auth/request_auth.ts";
import type { Catalogs } from "../catalog/index.ts";

export type SkillsRoutesOptions = {
  catalogs: Catalogs;
  verifyKey?: VerifyApiKeyFn;
};

export function createSkillsRoutes(opts: SkillsRoutesOptions): Hono<OwnerVariables> {
  const { catalogs } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono<OwnerVariables>();
  routes.use("/skills/*", requireOwner(verifyKey));

  routes.get("/skills", (c) => {
    const data = catalogs.skills.map(s => ({
      id: s.id,
      title: s.title,
    })).sort((a, b) => a.id.localeCompare(b.id));

    return c.json({ object: "list", data });
  });

  return routes;
}