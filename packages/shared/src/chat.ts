import { z } from "zod";
import { apiErrorSchema } from "./auth.js";
import { projectIdSchema } from "./projects.js";

export const chatBodySchema = z
  .string()
  .trim()
  .min(1, "Write a message first.")
  .max(2000)
  .refine(
    (body) => new TextEncoder().encode(body).byteLength <= 8000,
    "Messages must be at most 8 KiB.",
  );
export const chatSendSchema = z.strictObject({
  projectId: projectIdSchema,
  clientMessageId: z.uuid(),
  body: chatBodySchema,
});
export const chatMessageSchema = z.strictObject({
  id: z.cuid(),
  projectId: projectIdSchema,
  user: z.strictObject({
    id: z.string().min(1),
    name: z.string().min(1).max(80),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  body: z.string().min(1).max(2000),
  createdAt: z.iso.datetime(),
});
export const chatSendAckSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), message: chatMessageSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: apiErrorSchema,
    retryAfter: z.number().int().min(1).max(60).optional(),
  }),
]);
export const chatHistoryQuerySchema = z.strictObject({
  before: z.cuid().optional(),
});
export const chatHistoryResponseSchema = z.strictObject({
  messages: z.array(chatMessageSchema).max(50),
  nextCursor: z.cuid().nullable(),
});
export const chatTypingSchema = z.strictObject({
  projectId: projectIdSchema,
  typing: z.boolean(),
});
export const chatTypingEventSchema = z.strictObject({
  projectId: projectIdSchema,
  users: z.array(chatMessageSchema.shape.user),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSend = z.infer<typeof chatSendSchema>;
export type ChatSendAck = z.infer<typeof chatSendAckSchema>;
export type ChatTypingEvent = z.infer<typeof chatTypingEventSchema>;
