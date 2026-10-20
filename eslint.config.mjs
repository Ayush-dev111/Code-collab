import { defineConfig } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";
import { strictConfig } from "@collab/config/eslint";

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      ".tools/**",
      "**/.next/**",
      "**/dist/**",
      "**/.turbo/**",
      "packages/db/src/generated/**",
      "**/next-env.d.ts",
    ],
  },
  ...nextVitals.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx,js,mjs}"],
  })),
  ...nextTypeScript.map((config) => ({
    ...config,
    files: ["apps/web/**/*.{ts,tsx}"],
  })),
  ...strictConfig,
  {
    files: ["apps/web/**/*.{ts,tsx,js,mjs}"],
    settings: { next: { rootDir: "apps/web/" } },
  },
]);
