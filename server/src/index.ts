import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { auth } from "./auth.ts";
import { env } from "./env.ts";
import { inferenceRoutes } from "./inference.ts";

const app = new Hono();

app.get("/api/auth/ok", (c) => c.json({ status: "ok" }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
app.route("/v1", inferenceRoutes);

app.get("/", (c) =>
  c.json({
    name: "ai-assistant-gateway",
    auth: "/api/auth",
    inference: "/v1/chat/completions",
  }),
);

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`ai-assistant gateway listening on http://localhost:${info.port}`);
});