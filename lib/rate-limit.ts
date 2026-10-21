// Fixed-window rate limits kept in memory. The app runs as one process, so a
// shared counter needs no Redis. State lives on globalThis because the realtime
// server and Next.js route handlers load this module separately.
export const rateLimitPolicies = {
  chat: { user: 30, project: 120 },
  "invite-create": { user: 10, project: 20 },
  "invite-join": { user: 10, project: 60 },
  "invite-preview": { user: 60, project: null },
  run: { user: 6, project: 20 },
} as const;
export type RateLimitPolicy = keyof typeof rateLimitPolicies;

const WINDOW_MS = 60_000;

export class RateLimitError extends Error {
  constructor(public readonly retryAfter: number) {
    super(`Limit reached. Try again in ${retryAfter} seconds.`);
    this.name = "RateLimitError";
  }
}

type Window = { count: number; resetAt: number };
const store = globalThis as typeof globalThis & {
  collabRateLimits?: Map<string, Window>;
};
const windows = (store.collabRateLimits ??= new Map());

function current(key: string, now: number): Window {
  const window = windows.get(key);
  if (window && window.resetAt > now) return window;
  const fresh = { count: 0, resetAt: now + WINDOW_MS };
  windows.set(key, fresh);
  return fresh;
}

// Checks every scope before counting, so a rejected action never uses up
// another scope's allowance.
export function consumeRateLimit(
  policyName: RateLimitPolicy,
  userId: string,
  projectId?: string,
  now = Date.now(),
): void {
  const policy = rateLimitPolicies[policyName];
  const scopes: Array<[Window, number]> = [
    [current(`${policyName}:user:${userId}`, now), policy.user],
  ];
  if (projectId && policy.project !== null)
    scopes.push([
      current(`${policyName}:project:${projectId}`, now),
      policy.project,
    ]);
  for (const [window, limit] of scopes)
    if (window.count >= limit)
      throw new RateLimitError(
        Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
      );
  for (const [window] of scopes) window.count += 1;
  if (windows.size > 10_000)
    for (const [key, window] of windows)
      if (window.resetAt <= now) windows.delete(key);
}
