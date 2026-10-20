import { z } from "zod";
import { projectIdSchema } from "./projects.js";
import { itemIdSchema } from "./items.js";
import { apiErrorSchema } from "./auth.js";
import { realtimeUserSchema } from "./realtime.js";

export const presenceUpdateSchema = z.strictObject({
  projectId: projectIdSchema,
  itemId: itemIdSchema.nullable(),
});
export const presenceUpdateAckSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), error: apiErrorSchema }),
]);
export const projectPresenceSchema = z.strictObject({
  projectId: projectIdSchema,
  users: z.array(
    z.strictObject({
      user: realtimeUserSchema,
      itemIds: z.array(itemIdSchema),
      viewingOverview: z.boolean(),
    }),
  ),
});
export type PresenceUpdateAck = z.infer<typeof presenceUpdateAckSchema>;
export type ProjectPresence = z.infer<typeof projectPresenceSchema>;
export type PresenceMember = ProjectPresence["users"][number];
