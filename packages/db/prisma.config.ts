import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { databaseEnvironmentSchema } from "@collab/shared";

// Generating a client and SQL requires no live database. Commands that actually
// connect require the root .env, loaded explicitly with Node's --env-file.
const environment = databaseEnvironmentSchema.parse({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://collab:collab_dev_password@127.0.0.1:5432/collab?schema=public",
});
const directory = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  schema: resolve(directory, "prisma/schema.prisma"),
  migrations: { path: resolve(directory, "prisma/migrations") },
  datasource: { url: environment.DATABASE_URL },
});
