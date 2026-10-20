import { z } from "zod";

export const rateLimitEnvironmentSchema = z.object({
  REDIS_URL: z.url().refine((value) => {
    try {
      return ["redis:", "rediss:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }),
});
export const rateLimitResultSchema = z.tuple([
  z.union([z.literal(0), z.literal(1)]),
  z.number().int().min(0).max(60000),
]);
export const rateLimitPolicies = {
  chat: { user: 30, project: 120, windowMs: 60000 },
  "invite-create": { user: 10, project: 20, windowMs: 60000 },
  "invite-join": { user: 10, project: 60, windowMs: 60000 },
  "invite-join-project": { user: 60, project: 60, windowMs: 60000 },
  "invite-preview": { user: 60, project: null, windowMs: 60000 },
} as const;
export type RateLimitPolicy = keyof typeof rateLimitPolicies;
export const logEntrySchema = z.strictObject({
  timestamp: z.iso.datetime(),
  service: z.enum(["web", "realtime", "test"]),
  level: z.enum(["info", "warn", "error"]),
  event: z.enum([
    "request.completed",
    "request.failed",
    "notification.failed",
    "run.lease_release_failed",
    "realtime.started",
    "realtime.stopped",
    "realtime.failed",
    "chat.failed",
    "document.store_failed",
    "monitoring.invalid_configuration",
  ]),
  requestId: z.uuid().optional(),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().int().min(0).optional(),
  code: z
    .string()
    .regex(/^[A-Z_0-9]{1,64}$/)
    .optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const monitoringDsnSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length > 0 &&
      url.password === "" &&
      /^\/\d+$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
});
export const monitoringEnvironmentSchema = z.object({
  SENTRY_DSN: monitoringDsnSchema.optional(),
  SENTRY_ENVIRONMENT: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,40}$/)
    .default("development"),
});
export function safeLinkUrl(input: string): string | undefined {
  try {
    const value = input.trim();
    if (
      !value ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.includes("\\")
    )
      return undefined;
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    const url = new URL(value);
    if (
      !["https:", "http:", "mailto:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
