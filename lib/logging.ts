type LogDetails = {
  requestId?: string;
  status?: number;
  durationMs?: number;
  code?: string;
};

// One JSON line per event. Never pass request bodies, secrets or raw errors.
export function log(
  level: "info" | "warn" | "error",
  event: string,
  details: LogDetails = {},
) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
