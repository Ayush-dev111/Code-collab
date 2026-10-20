import {
  initializeServerMonitoring,
  captureServerError,
  flushServerMonitoring,
} from "@collab/server/monitoring";
import { structuredLog } from "@collab/server";
initializeServerMonitoring();
let failed = false;
async function fatal(error: unknown) {
  if (failed) return;
  failed = true;
  structuredLog("realtime", "error", "realtime.failed", {
    code: "UNHANDLED_ERROR",
  });
  captureServerError(error);
  try {
    await flushServerMonitoring();
  } finally {
    process.exit(1);
  }
}
process.on("uncaughtException", (error) => void fatal(error));
process.on("unhandledRejection", (error: unknown) => void fatal(error));
