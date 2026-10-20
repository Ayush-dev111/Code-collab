import { logEntrySchema, type LogEntry } from "@collab/shared";

export function structuredLog(
  service: "web" | "realtime" | "test",
  level: "info" | "warn" | "error",
  event: LogEntry["event"],
  details: Pick<LogEntry, "requestId" | "status" | "durationMs" | "code"> = {},
) {
  const entry = logEntrySchema.parse({
    timestamp: new Date().toISOString(),
    service,
    level,
    event,
    ...details,
  });
  // Only allowlisted metadata is emitted; never stringify an Error or request.
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
