import { config } from "dotenv";
import { z } from "zod";

config({ quiet: true });

const envSchema = z.object({
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET is required and must be at least 32 characters"),
  BETTER_AUTH_URL: z
    .string()
    .url("BETTER_AUTH_URL must be an absolute URL, e.g. http://localhost:9091"),
  INFERENCE_URL: z
    .string()
    .url("INFERENCE_URL must be an absolute URL of the OpenAI-compatible engine"),
  PORT: z.coerce.number().int().positive().default(9091),
  DB_PATH: z.string().default("./data/gateway.db"),
  INFERENCE_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  INFERENCE_RATE_BURST: z.coerce.number().int().positive().default(20),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Gateway: invalid environment configuration");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

const inferenceUrl = new URL(env.INFERENCE_URL);
const inferencePort = inferenceUrl.port
  ? Number(inferenceUrl.port)
  : inferenceUrl.protocol === "https:"
    ? 443
    : 80;
if (inferencePort === env.PORT) {
  console.error(
    `Gateway: INFERENCE_URL (${env.INFERENCE_URL}) must not point at this gateway's own port (PORT=${env.PORT}).`,
  );
  process.exit(1);
}

export type Env = typeof env;