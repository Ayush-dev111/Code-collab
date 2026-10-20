import { z } from "zod";
import { projectIdSchema, roleSchema } from "./projects.js";
import { apiErrorSchema } from "./auth.js";

export const realtimeTokenClaimsSchema = z
  .strictObject({
    userId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    projectId: projectIdSchema,
    role: roleSchema,
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    iss: z.url({ protocol: /^https?$/ }),
    aud: z.literal("collab-realtime"),
  })
  .refine(
    (claims) => claims.exp > claims.iat && claims.exp - claims.iat <= 300,
    "Token lifetime must be at most five minutes",
  );
export const realtimeTokenSchema = z.string().min(1).max(8192);
export const realtimeTokenRequestSchema = z.strictObject({
  projectId: projectIdSchema,
});
export const realtimeTokenResponseSchema = z.object({
  token: realtimeTokenSchema,
  expiresAt: z.iso.datetime(),
  url: z.url({ protocol: /^https?$/ }),
});
export const realtimeSocketAuthSchema = z.strictObject({
  token: realtimeTokenSchema,
});
export const yjsMessageSchema = z
  .instanceof(Uint8Array)
  .refine(
    (message) => message.byteLength > 0 && message.byteLength <= 8388608,
    "Invalid Yjs message size",
  );
export const yjsSyncTypeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);
export const treeSubscribeSchema = z.strictObject({
  projectId: projectIdSchema,
});
export const treeSubscribeAckSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: apiErrorSchema }),
]);
export const treeSubscribeResponseSchema = treeSubscribeAckSchema;
export const treeChangedNotificationSchema = z.strictObject({
  projectId: projectIdSchema,
  userId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
});
export const treeNotificationResponseSchema = z.object({
  published: z.boolean(),
});
export const realtimeDocumentNameSchema = z
  .string()
  .regex(/^item:c[a-z0-9]+$/, "Choose an item document")
  .max(160);
export const realtimeUserSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(80),
  image: z.url({ protocol: /^https?$/ }).nullable(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export const realtimeConnectionContextSchema = z.strictObject({
  token: realtimeTokenSchema,
  claims: realtimeTokenClaimsSchema,
  user: realtimeUserSchema,
});
const relativePositionIdSchema = z.strictObject({
  client: z.number().int().min(0).max(0xffffffff),
  clock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export const relativePositionSchema = z
  .strictObject({
    type: relativePositionIdSchema.nullable().optional(),
    tname: z.string().max(256).nullable().optional(),
    item: relativePositionIdSchema.nullable().optional(),
    assoc: z.number().int().nullable().optional(),
  })
  .refine(
    (position) =>
      position.type != null || position.tname != null || position.item != null,
    "A relative position must identify a shared type or item",
  );
export const awarenessCursorSchema = z.strictObject({
  anchor: relativePositionSchema,
  head: relativePositionSchema,
});
export const awarenessStateSchema = z
  .object({
    user: realtimeUserSchema,
    cursor: awarenessCursorSchema.nullable().optional(),
    selection: awarenessCursorSchema.nullable().optional(),
  })
  .passthrough();
export function userColor(userId: string): string {
  const colors = [
    "#047857",
    "#1d4ed8",
    "#7c3aed",
    "#b45309",
    "#be185d",
    "#0e7490",
  ] as const;
  let hash = 0;
  for (const character of userId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length] ?? colors[0];
}
export const notificationEnvironmentSchema = z.object({
  REALTIME_HTTP_URL: z
    .url({ protocol: /^https?$/ })
    .default("http://127.0.0.1:3001"),
  REALTIME_INTERNAL_SECRET: z.string().min(32),
});
export const storageEnvironmentSchema = z.object({
  S3_ENDPOINT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url({ protocol: /^https?$/ }).optional(),
  ),
  S3_REGION: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("us-east-1"),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_SESSION_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
});
export const storageObjectKeySchema = z
  .string()
  .regex(
    /^projects\/c[a-z0-9]+\/items\/c[a-z0-9]+\/[0-9a-f-]+\.(?:png|jpg|gif|webp)$/,
  );
export type RealtimeTokenClaims = z.infer<typeof realtimeTokenClaimsSchema>;
export type RealtimeUser = z.infer<typeof realtimeUserSchema>;
export type RealtimeConnectionContext = z.infer<
  typeof realtimeConnectionContextSchema
>;
