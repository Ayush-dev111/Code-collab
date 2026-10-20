import {
  notificationEnvironmentSchema,
  runNotificationSchema,
  treeNotificationResponseSchema,
  type RunNotification,
} from "@collab/shared";
import { structuredLog } from "@collab/server";

export async function notifyRun(
  notification: RunNotification,
): Promise<boolean> {
  const configuration = notificationEnvironmentSchema.safeParse(process.env);
  const parsed = runNotificationSchema.safeParse(notification);
  if (!configuration.success || !parsed.success) return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(
        new URL("/internal/run-event", configuration.data.REALTIME_HTTP_URL),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${configuration.data.REALTIME_INTERNAL_SECRET}`,
          },
          body: JSON.stringify(parsed.data),
          cache: "no-store",
          signal: AbortSignal.timeout(1000),
          redirect: "error",
        },
      );
      if (
        response.ok &&
        treeNotificationResponseSchema.parse(await response.json()).published
      )
        return true;
      await response.body?.cancel();
    } catch {
      /* History and periodic refetch recover missed notifications. */
    }
  }
  structuredLog("web", "warn", "notification.failed", {
    code: "RUN_NOTIFICATION_UNAVAILABLE",
  });
  return false;
}
