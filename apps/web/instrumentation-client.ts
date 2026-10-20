import * as Sentry from "@sentry/nextjs";
import { monitoringDsnSchema, privateMonitoringOptions } from "@collab/shared";
const parsed = monitoringDsnSchema.safeParse(
  process.env.NEXT_PUBLIC_SENTRY_DSN,
);
if (parsed.success)
  Sentry.init({ dsn: parsed.data, ...privateMonitoringOptions });
