import type { IncomingHttpHeaders } from "node:http";
import { getAuth } from "@/lib/auth";
import { getDatabase } from "@/lib/db";
import { realtimeUser, type RealtimeUser, type Role } from "@/lib/shared";

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

// Short-lived caches so opening several documents costs no extra queries.
const CACHE_MS = 30_000;
const roles = new Map<string, { role: Role; at: number }>();
const items = new Map<string, { projectId: string; at: number }>();

function prune<T extends { at: number }>(cache: Map<string, T>) {
  if (cache.size < 1000) return;
  const cutoff = Date.now() - CACHE_MS;
  for (const [key, entry] of cache) if (entry.at < cutoff) cache.delete(key);
}

export async function projectRole(
  projectId: string,
  userId: string,
): Promise<Role> {
  const key = `${projectId}:${userId}`;
  const cached = roles.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.role;
  const membership = await getDatabase().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  if (!membership) {
    roles.delete(key);
    throw new AccessError("You are not a member of this project.");
  }
  roles.set(key, { role: membership.role, at: Date.now() });
  prune(roles);
  return membership.role;
}

async function documentProject(itemId: string): Promise<string> {
  const cached = items.get(itemId);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.projectId;
  const item = await getDatabase().item.findFirst({
    where: { id: itemId, type: { in: ["PAGE", "CODE"] } },
    select: { projectId: true },
  });
  if (!item) throw new AccessError("This document is unavailable.");
  items.set(itemId, { projectId: item.projectId, at: Date.now() });
  prune(items);
  return item.projectId;
}

export async function authorizeDocument(headers: Headers, itemId: string) {
  const [user, projectId] = await Promise.all([
    sessionUser(headers),
    documentProject(itemId),
  ]);
  const role = await projectRole(projectId, user.id);
  return { user, projectId, role };
}
