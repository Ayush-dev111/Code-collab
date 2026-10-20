import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (process.env.CI !== "true" || existsSync(".env"))
  throw new Error(
    "CI environment setup requires CI=true and no existing .env.",
  );
const secret = () => randomBytes(32).toString("hex");
const values = {
  DATABASE_URL:
    "postgresql://collab:ci-only-password@127.0.0.1:5432/collab?schema=public",
  REDIS_URL: "redis://127.0.0.1:6379",
  BETTER_AUTH_URL: "http://127.0.0.1:3000",
  BETTER_AUTH_SECRET: secret(),
  REALTIME_HOST: "127.0.0.1",
  REALTIME_PORT: "3001",
  REALTIME_URL: "ws://127.0.0.1:3001",
  REALTIME_HTTP_URL: "http://127.0.0.1:3001",
  REALTIME_TOKEN_SECRET: secret(),
  REALTIME_INTERNAL_SECRET: secret(),
  SENTRY_ENVIRONMENT: "ci",
};
writeFileSync(
  ".env",
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log("Created isolated CI configuration with ephemeral secrets.");
