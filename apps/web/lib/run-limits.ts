import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  RUN_LEASE_MS,
  runLimitResponseSchema,
  type RunnerEnvironment,
} from "@collab/shared";
import { ApiError } from "./api";
import { structuredLog } from "@collab/server";

// Counters and the per-file lease are acquired atomically. Failed acquisition
// never consumes a run allowance; keys expire even if the web process dies.
const acquireScript = `
local user = tonumber(redis.call('GET', KEYS[1]) or '0')
local project = tonumber(redis.call('GET', KEYS[2]) or '0')
if user >= 6 then return {1, math.max(1, redis.call('PTTL', KEYS[1]))} end
if project >= 20 then return {1, math.max(1, redis.call('PTTL', KEYS[2]))} end
if redis.call('EXISTS', KEYS[3]) == 1 then return {2, math.max(1, redis.call('PTTL', KEYS[3]))} end
redis.call('SET', KEYS[3], ARGV[1], 'PX', ARGV[2])
if redis.call('INCR', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
if redis.call('INCR', KEYS[2]) == 1 then redis.call('PEXPIRE', KEYS[2], 60000) end
return {0, 0}
`;
const releaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CollabRedisClient = RedisClientType<any, any, any, any>;

const redisGlobal = globalThis as typeof globalThis & {
  collabRedis?: CollabRedisClient | undefined;
};

async function getRedisClient(configuration: RunnerEnvironment) {
  if (redisGlobal.collabRedis?.isOpen) {
    return redisGlobal.collabRedis;
  }
  const client = createClient({
    url: configuration.REDIS_URL,
    socket: {
      connectTimeout: 1500,
      reconnectStrategy: (retries) => (retries < 3 ? 500 : false),
    },
    disableOfflineQueue: true,
  });
  // Never print connection URLs, credentials or a service error containing them.
  client.on("error", () => {
    if (!client.isOpen && redisGlobal.collabRedis === client) {
      redisGlobal.collabRedis = undefined;
    }
  });
  await client.connect();
  redisGlobal.collabRedis = client;
  return client;
}

async function evaluate(
  configuration: RunnerEnvironment,
  script: string,
  keys: string[],
  args: string[],
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = await getRedisClient(configuration);
    return await Promise.race([
      client.eval(script, { keys, arguments: args }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Redis operation timed out")),
          2500,
        );
      }),
    ]);
  } catch {
    if (redisGlobal.collabRedis && !redisGlobal.collabRedis.isOpen) {
      try {
        redisGlobal.collabRedis.destroy();
      } catch {
        // Ignore destruction errors
      }
      redisGlobal.collabRedis = undefined;
    }
    throw new ApiError(
      503,
      "RATE_LIMIT_UNAVAILABLE",
      "Code execution is unavailable while its rate limiter cannot be reached.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function acquireRunLease(
  configuration: RunnerEnvironment,
  userId: string,
  projectId: string,
  itemId: string,
) {
  const nonce = randomUUID();
  const key = `collab:run:active:${projectId}:${itemId}`;
  const result = await evaluate(
    configuration,
    acquireScript,
    [`collab:run:user:${userId}`, `collab:run:project:${projectId}`, key],
    [nonce, String(RUN_LEASE_MS)],
  );
  const parsed = runLimitResponseSchema.safeParse(result);
  if (!parsed.success)
    throw new ApiError(
      503,
      "RATE_LIMIT_UNAVAILABLE",
      "The rate limiter returned an invalid response.",
    );
  const [code, milliseconds] = parsed.data;
  if (code === 1)
    throw new ApiError(
      429,
      "RUN_RATE_LIMIT",
      "Run limit reached. Try again in a minute.",
      Math.max(1, Math.ceil(milliseconds / 1000)),
    );
  if (code === 2)
    throw new ApiError(
      409,
      "RUN_IN_PROGRESS",
      "A collaborator is already running this file. Wait for that run to finish.",
      Math.max(1, Math.ceil(milliseconds / 1000)),
    );
  return async () => {
    try {
      await evaluate(configuration, releaseScript, [key], [nonce]);
    } catch {
      structuredLog("web", "warn", "run.lease_release_failed", {
        code: "REDIS_UNAVAILABLE",
      });
    }
  };
}
