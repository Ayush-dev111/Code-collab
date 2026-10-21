// The realtime server shares the app's origin, so WebSockets only need the
// ws:/wss: form of that same host.
export function contentSecurityPolicy(
  nonce: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const connections = new Set(["'self'"]);
  try {
    const app = new URL(environment.BETTER_AUTH_URL ?? "");
    connections.add(
      `${app.protocol === "https:" ? "wss:" : "ws:"}//${app.host}`,
    );
  } catch {
    /* Without a configured origin, only 'self' is allowed. */
  }
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
