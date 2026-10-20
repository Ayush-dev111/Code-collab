import { createClient } from "redis";
import {
  rateLimitEnvironmentSchema,
  rateLimitResultSchema,
  rateLimitPolicies,
  type RateLimitPolicy,
} from "@collab/shared";

export class RateLimitError extends Error {
  constructor(
    public readonly code: "RATE_LIMITED" | "RATE_LIMIT_UNAVAILABLE",
    public readonly retryAfter?: number,
  ) {
    super(
      code === "RATE_LIMITED"
        ? `Limit reached. Try again in ${retryAfter ?? 60} seconds.`
        : "This action is unavailable while its rate limiter cannot be reached.",
    );
    this.name = "RateLimitError";
  }
}
export async function evaluateRedis(
  url: string,
  script: string,
  keys: string[],
  args: string[],
) {
  const parsed = rateLimitEnvironmentSchema.safeParse({ REDIS_URL: url });
  if (!parsed.success) throw new RateLimitError("RATE_LIMIT_UNAVAILABLE");
  const client = createClient({
    url: parsed.data.REDIS_URL,
    socket: { connectTimeout: 1500, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on("error", () => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client
        .connect()
        .then(() => client.eval(script, { keys, arguments: args })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RateLimitError("RATE_LIMIT_UNAVAILABLE")),
          2500,
        );
      }),
    ]);
  } catch {
    throw new RateLimitError("RATE_LIMIT_UNAVAILABLE");
  } finally {
    clearTimeout(timer);
    if (client.isOpen) client.destroy();
  }
}

// All scopes are checked before any counter increments. Rejected operations
// cannot consume another scope's allowance, and every new key gets an expiry.
const consumeScript = `
-- collab-fixed-window-v1
for i, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count >= tonumber(ARGV[i + 1]) then
    return {1, math.max(1, redis.call('PTTL', key))}
  end
end
for _, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
end
return {0, 0}
`;
export async function consumeRateLimit(
  policyName: RateLimitPolicy,
  userId: string,
  projectId?: string,
) {
  const config = rateLimitEnvironmentSchema.safeParse(process.env);
  if (!config.success) throw new RateLimitError("RATE_LIMIT_UNAVAILABLE");
  const policy = rateLimitPolicies[policyName];
  const keys = [`collab:limit:${policyName}:user:${userId}`];
  const args = [String(policy.windowMs), String(policy.user)];
  if (projectId && policy.project !== null) {
    keys.push(`collab:limit:${policyName}:project:${projectId}`);
    args.push(String(policy.project));
  }
  const result = rateLimitResultSchema.safeParse(
    await evaluateRedis(config.data.REDIS_URL, consumeScript, keys, args),
  );
  if (!result.success) throw new RateLimitError("RATE_LIMIT_UNAVAILABLE");
  if (result.data[0] === 1)
    throw new RateLimitError(
      "RATE_LIMITED",
      Math.max(1, Math.ceil(result.data[1] / 1000)),
    );
}
