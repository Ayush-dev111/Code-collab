import { existsSync } from "node:fs";
import { verifyHardening } from "./phase8-hardening.ts";
import { startTestStack } from "./test-support/test-stack.ts";

const stack = await startTestStack(process.argv.includes("--redis-fixture"));
if (
  process.platform === "win32" &&
  existsSync("C:/Program Files/Google/Chrome/Application/chrome.exe")
)
  stack.environment.PLAYWRIGHT_CHROME_CHANNEL = "chrome";
try {
  await verifyHardening(stack);
  const child = stack.start("node_modules/@playwright/test/cli.js", [
    "test",
    "--config",
    "playwright.config.ts",
  ]);
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error("Phase 8 Playwright acceptance failed")),
    );
  });
  console.log(
    stack.fixture
      ? "Phase 8 local acceptance passed with Redis protocol fixtures. Real Redis/hosted CI verification remains pending."
      : "Phase 8 acceptance passed with real Redis and two browser contexts.",
  );
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof Error ? error.message : "Phase 8 checks failed",
  );
  console.error(stack.safeLogs());
} finally {
  await stack.stop();
}
