import * as Sentry from "@sentry/nextjs";
import {
  monitoringEnvironmentSchema,
  privateMonitoringOptions,
} from "@collab/shared";
import { structuredLog } from "@collab/server";
const parsed = monitoringEnvironmentSchema.safeParse({
  ...process.env,
  SENTRY_DSN: process.env.SENTRY_DSN || undefined,
});
if (!parsed.success)
  structuredLog("web", "error", "monitoring.invalid_configuration", {
    code: "INVALID_SENTRY_CONFIGURATION",
  });
else if (parsed.data.SENTRY_DSN)
  Sentry.init({
    dsn: parsed.data.SENTRY_DSN,
    environment: parsed.data.SENTRY_ENVIRONMENT,
    ...privateMonitoringOptions,
  });
