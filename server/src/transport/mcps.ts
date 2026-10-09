import { Hono } from "hono";
import { requireApiKey, requireOwner } from "../request_auth.ts";
import type { OwnerVariables, VerifyApiKeyFn } from "../request_auth.ts";
import type { Catalogs } from "../catalog/index.ts";

export type McpRoutesOptions = {
  catalogs: Catalogs;
  verifyKey?: VerifyApiKeyFn;
};

export function createMcpRoutes(opts: McpRoutesOptions): Hono<OwnerVariables> {
  const { catalogs } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono<OwnerVariables>();
  routes.use("/mcps/*", requireOwner(verifyKey));

  routes.get("/mcps", (c) => {
    const data = catalogs.mcps.map(s => ({
      name: s.name,
    })).sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ object: "list", data });
  });

  return routes;
}