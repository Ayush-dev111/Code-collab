import { getDatabase } from "@collab/db";
import {
  hasMinimumRole,
  projectIdSchema,
  roleSchema,
  type Role,
} from "@collab/shared";
import { headers } from "next/headers";
import { ApiError, parseInput } from "@/lib/api";
import { getAuth } from "@/lib/auth";

export async function requireSession(requestHeaders?: Headers) {
  const session = await getAuth().api.getSession({
    headers: requestHeaders ?? (await headers()),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  if (!session)
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return session;
}

export async function requireRole(
  projectId: string,
  minRole: Role,
  requestHeaders?: Headers,
) {
  const id = parseInput(projectIdSchema, projectId);
  const minimum = parseInput(roleSchema, minRole);
  const session = await requireSession(requestHeaders);
  const membership = await getDatabase().projectMember.findUnique({
    where: { projectId_userId: { projectId: id, userId: session.user.id } },
  });
  if (!membership || !hasMinimumRole(membership.role, minimum)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "You do not have permission to access this project.",
    );
  }
  return { session, membership };
}
