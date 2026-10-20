import * as Sentry from "@sentry/node";
import {
  monitoringEnvironmentSchema,
  privateMonitoringOptions,
} from "@collab/shared";
import { structuredLog } from "./logging.js";

export function initializeServerMonitoring() {
  const input = {
    ...process.env,
    SENTRY_DSN: process.env.SENTRY_DSN || undefined,
  };
  const parsed = monitoringEnvironmentSchema.safeParse(input);
  if (!parsed.success) {
    structuredLog("realtime", "error", "monitoring.invalid_configuration", {
      code: "INVALID_SENTRY_CONFIGURATION",
    });
    return;
  }
  if (!parsed.data.SENTRY_DSN) return;
  Sentry.init({
    dsn: parsed.data.SENTRY_DSN,
    environment: parsed.data.SENTRY_ENVIRONMENT,
    defaultIntegrations: false,
    ...privateMonitoringOptions,
  });
}
export function captureServerError(error: unknown) {
  if (Sentry.getClient()) Sentry.captureException(error);
}
export async function flushServerMonitoring() {
  if (Sentry.getClient()) await Sentry.flush(2000);
}
