import { monitoringDsnSchema } from "@collab/shared";

export function contentSecurityPolicy(
  nonce: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const connections = new Set(["'self'"]);
  for (const candidate of [
    environment.REALTIME_HTTP_URL,
    environment.REALTIME_URL,
  ]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) continue;
      connections.add(url.origin);
      url.protocol =
        url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
      connections.add(url.origin);
    } catch {
      /* Invalid services remain inaccessible. */
    }
  }
  const sentry = monitoringDsnSchema.safeParse(
    environment.NEXT_PUBLIC_SENTRY_DSN,
  );
  if (sentry.success) connections.add(new URL(sentry.data).origin);
  const development = environment.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src ${[...connections].join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
  ].join("; ");
}
