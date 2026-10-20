import {
  notificationEnvironmentSchema,
  treeChangedNotificationSchema,
  treeNotificationResponseSchema,
} from "@collab/shared";
import { structuredLog } from "@collab/server";

type TreeNotification = {
  projectId: string;
  userId: string;
  sessionId: string;
};

export async function notifyTreeChanged(
  notification: TreeNotification,
): Promise<boolean> {
  const environment = notificationEnvironmentSchema.safeParse(process.env);
  const input = treeChangedNotificationSchema.safeParse(notification);
  if (!environment.success || !input.success) {
    structuredLog("web", "error", "notification.failed", {
      code: "INVALID_CONFIGURATION",
    });
    return false;
  }
  const url = new URL(
    "/internal/tree-changed",
    environment.data.REALTIME_HTTP_URL,
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${environment.data.REALTIME_INTERNAL_SECRET}`,
        },
        body: JSON.stringify(input.data),
        cache: "no-store",
        signal: AbortSignal.timeout(600),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        const result = treeNotificationResponseSchema.safeParse(body);
        if (result.success && result.data.published) return true;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // A committed tree write remains valid when the realtime relay is down.
      // The response tells the client to show pending sync and refetch later.
    }
    if (attempt < 2) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  structuredLog("web", "warn", "notification.failed", {
    code: "TREE_NOTIFICATION_UNAVAILABLE",
  });
  return false;
}
