import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const environmentPath = fileURLToPath(
  new URL("../../../.env", import.meta.url),
);
if (existsSync(environmentPath)) {
  loadEnvFile(environmentPath);
}

// Loading the environment here avoids passing --env-file through Next's workers.
await import(
  new URL("../node_modules/next/dist/bin/next", import.meta.url).href
);
