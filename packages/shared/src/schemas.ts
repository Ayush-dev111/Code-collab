import { z } from "zod";

export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z
    .url()
    .refine(
      (value) =>
        URL.canParse(value) &&
        ["postgres:", "postgresql:"].includes(new URL(value).protocol),
      "DATABASE_URL must use PostgreSQL",
    ),
});

export const realtimeEnvironmentSchema = z.object({
  REALTIME_HOST: z.enum(["127.0.0.1", "0.0.0.0", "::1"]).default("127.0.0.1"),
  REALTIME_PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  REALTIME_URL: z.url({ protocol: /^wss?$/ }).default("ws://127.0.0.1:3001"),
  REALTIME_HTTP_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://127.0.0.1:3001"),
  BETTER_AUTH_URL: z.url({ protocol: /^https?$/ }),
  REALTIME_TOKEN_SECRET: z.string().min(32),
  REALTIME_INTERNAL_SECRET: z.string().min(32),
  REALTIME_MAX_DOCUMENT_BYTES: z.coerce
    .number()
    .int()
    .min(65536)
    .max(67108864)
    .default(8388608),
  REALTIME_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .min(16384)
    .max(8388608)
    .default(1048576),
});

// This public liveness request carries no project, user, or database information.
export const livenessRequestSchema = z.object({
  method: z.literal("GET"),
  path: z.literal("/health"),
});

export const livenessResponseSchema = z.object({
  service: z.literal("realtime"),
  status: z.literal("ok"),
  phase: z.union([
    z.literal(0),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
  ]),
});

export type LivenessResponse = z.infer<typeof livenessResponseSchema>;
