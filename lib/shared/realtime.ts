import { z } from "zod";

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
// The server stamps `user` on every awareness state, so peers can trust it.
export const awarenessStateSchema = z
  .object({ user: realtimeUserSchema })
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
export function realtimeUser(user: {
  id: string;
  name: string;
  image?: string | null | undefined;
}): RealtimeUser {
  const candidate = {
    id: user.id,
    name: user.name.trim().slice(0, 80) || "Collaborator",
    image: user.image ?? null,
    color: userColor(user.id),
  };
  const parsed = realtimeUserSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { ...candidate, image: null };
}
export type RealtimeUser = z.infer<typeof realtimeUserSchema>;
