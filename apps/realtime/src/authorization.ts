import { getDatabase } from "@collab/db";
import {
  hasMinimumRole,
  projectIdSchema,
  realtimeEnvironmentSchema,
  realtimeTokenClaimsSchema,
  type RealtimeTokenClaims,
  type Role,
} from "@collab/shared";
import { verifyRealtimeToken } from "@collab/shared/realtime-token";

export class RealtimeAuthorizationError extends Error {
  constructor(message = "The connection is not authorized.") {
    super(message);
    this.name = "RealtimeAuthorizationError";
  }
}

export interface RealtimeActor {
  userId: string;
  sessionId: string;
  projectId: string;
}

export interface RealtimeAuthorization {
  claims: RealtimeTokenClaims;
  role: Role;
  user: { id: string; name: string; image: string | null };
}
interface CachedActor {
  result: Pick<RealtimeAuthorization, "role" | "user">;
  cachedAt: number;
}

interface CachedItem {
  exists: boolean;
  cachedAt: number;
}

const ACTOR_CACHE_TTL_MS = 5000;
const actorCache = new Map<string, CachedActor>();
const itemCache = new Map<string, CachedItem>();

function pruneCache() {
  if (actorCache.size > 500) {
    const cutoff = Date.now() - ACTOR_CACHE_TTL_MS;
    for (const [key, entry] of actorCache) {
      if (entry.cachedAt < cutoff) actorCache.delete(key);
    }
  }
  if (itemCache.size > 500) {
    const cutoff = Date.now() - ACTOR_CACHE_TTL_MS;
    for (const [key, entry] of itemCache) {
      if (entry.cachedAt < cutoff) itemCache.delete(key);
    }
  }
}

export async function requireRealtimeActor(
  actor: RealtimeActor,
  minimumRole: Role = "VIEWER",
): Promise<Pick<RealtimeAuthorization, "role" | "user">> {
  const projectId = projectIdSchema.parse(actor.projectId);
  const cacheKey = `${actor.sessionId}:${projectId}:${actor.userId}:${minimumRole}`;
  const now = Date.now();
  const cached = actorCache.get(cacheKey);
  if (cached && now - cached.cachedAt < ACTOR_CACHE_TTL_MS) {
    return cached.result;
  }

  const database = getDatabase();
  const [session, membership] = await Promise.all([
    database.session.findUnique({
      where: { id: actor.sessionId },
      include: { user: { select: { id: true, name: true, image: true } } },
    }),
    database.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: actor.userId } },
      select: { role: true },
    }),
  ]);
  if (
    !session ||
    session.userId !== actor.userId ||
    session.expiresAt.getTime() <= now ||
    !membership ||
    !hasMinimumRole(membership.role, minimumRole)
  ) {
    actorCache.delete(cacheKey);
    throw new RealtimeAuthorizationError();
  }
  const result = { role: membership.role, user: session.user };
  actorCache.set(cacheKey, { result, cachedAt: now });
  pruneCache();
  return result;
}

let cachedRealtimeEnv: ReturnType<typeof realtimeEnvironmentSchema.parse> | undefined;
function getRealtimeEnvironment() {
  return (cachedRealtimeEnv ??= realtimeEnvironmentSchema.parse(process.env));
}

export async function requireRealtimeAuthorization(
  token: unknown,
  projectId?: string,
  itemId?: string,
): Promise<RealtimeAuthorization> {
  const environment = getRealtimeEnvironment();
  let claims: RealtimeTokenClaims;
  try {
    claims = realtimeTokenClaimsSchema.parse(
      verifyRealtimeToken(token, {
        secret: environment.REALTIME_TOKEN_SECRET,
        issuer: environment.BETTER_AUTH_URL,
      }),
    );
  } catch {
    throw new RealtimeAuthorizationError(
      "The connection token is invalid or expired.",
    );
  }
  if (projectId && claims.projectId !== projectId)
    throw new RealtimeAuthorizationError();
  const authorization = await requireRealtimeActor(claims);
  if (itemId) {
    const itemCacheKey = `${claims.projectId}:${itemId}`;
    const now = Date.now();
    const cachedItem = itemCache.get(itemCacheKey);
    if (!cachedItem || now - cachedItem.cachedAt >= ACTOR_CACHE_TTL_MS) {
      const item = await getDatabase().item.findFirst({
        where: {
          id: itemId,
          projectId: claims.projectId,
          type: { in: ["PAGE", "CODE"] },
        },
        select: { id: true },
      });
      if (!item) {
        itemCache.delete(itemCacheKey);
        throw new RealtimeAuthorizationError("This document is unavailable.");
      }
      itemCache.set(itemCacheKey, { exists: true, cachedAt: now });
      pruneCache();
    }
  }
  return { claims, ...authorization };
}
