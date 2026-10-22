import type { IncomingHttpHeaders } from "node:http";
import { getAuth } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import {
  realtimeUser,
  roleSchema,
  type RealtimeUser,
  type Role,
} from "@/lib/shared";

// Realtime connections are checked once when they open, not on every message.
// The browser sends the normal session cookie because the realtime server
// shares the app's origin.

export class AccessError extends Error {}

export function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  }
  return headers;
}

export async function sessionUser(headers: Headers): Promise<RealtimeUser> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new AccessError("Sign in to continue.");
  return realtimeUser(session.user);
}

export async function projectRole(
  projectId: string,
  userId: string,
): Promise<Role> {
  const membership = await getDatabase().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!membership)
    throw new AccessError("You are not a member of this project.");
  return membership.role;
}

// One query checks that the document exists, finds the user's role in its
// project and, when the document is not open yet, reads its saved state, so
// opening a page costs a single database round trip.
export async function authorizeDocument(
  headers: Headers,
  itemId: string,
  withState: boolean,
) {
  const user = await sessionUser(headers);
  const rows = await getDatabase().$queryRaw<
    Array<{
      projectId: string;
      role: string | null;
      yjsState: Uint8Array | null;
    }>
  >`
    SELECT i."projectId", m.role::text AS role,
           CASE WHEN ${withState}::boolean THEN i."yjsState" END AS "yjsState"
    FROM item i
    LEFT JOIN project_member m
      ON m."projectId" = i."projectId" AND m."userId" = ${user.id}
    WHERE i.id = ${itemId} AND i.type IN ('PAGE', 'CODE')
  `;
  const row = rows[0];
  if (!row) throw new AccessError("This document is unavailable.");
  const role = roleSchema.safeParse(row.role);
  if (!role.success)
    throw new AccessError("You are not a member of this project.");
  return {
    user,
    projectId: row.projectId,
    role: role.data,
    state: row.yjsState,
  };
}
