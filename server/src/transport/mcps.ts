import { Hono } from "hono";
import { keyGateResponse, requireApiKey } from "../api_key.ts";
import type { Catalogs } from "../catalog/index.ts";
import type { VerifyApiKeyFn } from "../plugins/routes.ts";

export type McpRoutesOptions = {
  catalogs: Catalogs;
  verifyKey?: VerifyApiKeyFn;
};

export function createMcpRoutes(opts: McpRoutesOptions): Hono {
  const { catalogs } = opts;
  const verifyKey = opts.verifyKey ?? requireApiKey;
  const routes = new Hono();

  routes.get("/mcps", async (c) => {
    const auth = await verifyKey(c);
    if (!auth.ok) return keyGateResponse(c, auth);

    const data = catalogs.mcps.map(s => ({
      name: s.name,
    })).sort((a, b) => a.name.localeCompare(b.name));

    return c.json({ object: "list", data });
  });

  return routes;
}