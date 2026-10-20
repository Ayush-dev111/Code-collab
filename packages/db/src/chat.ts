import { chatMessageSchema, userColor } from "@collab/shared";

export const chatUserSelection = { id: true, name: true } as const;
export function serializeChatMessage(row: {
  id: string;
  projectId: string;
  body: string;
  createdAt: Date;
  user: { id: string; name: string };
}) {
  return chatMessageSchema.parse({
    id: row.id,
    projectId: row.projectId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    user: {
      id: row.user.id,
      name: row.user.name.trim().slice(0, 80) || "Collaborator",
      color: userColor(row.user.id),
    },
  });
}
