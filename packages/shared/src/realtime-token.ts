// Server-only entry point. Never re-export this file from the browser-safe index.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  realtimeTokenClaimsSchema,
  realtimeTokenSchema,
  type RealtimeTokenClaims,
} from "./realtime.js";

export const REALTIME_TOKEN_TTL_SECONDS = 300;
export const REALTIME_TOKEN_AUDIENCE = "collab-realtime";
const HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}', "utf8").toString(
  "base64url",
);

export interface RealtimeTokenOptions {
  secret: string;
  issuer: string;
  now?: number;
}

export type RealtimeTokenIdentity = Pick<
  RealtimeTokenClaims,
  "userId" | "sessionId" | "projectId" | "role"
>;

function signature(input: string, secret: string): Buffer {
  if (Buffer.byteLength(secret, "utf8") < 32)
    throw new Error("Realtime signing secret must contain at least 32 bytes.");
  return createHmac("sha256", secret).update(input, "ascii").digest();
}

function decodeSegment(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Invalid token.");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment)
    throw new Error("Invalid token.");
  return bytes;
}

export function signRealtimeToken(
  identity: RealtimeTokenIdentity,
  options: RealtimeTokenOptions,
): { token: string; claims: RealtimeTokenClaims } {
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const claims = realtimeTokenClaimsSchema.parse({
    ...identity,
    iat: now,
    exp: now + REALTIME_TOKEN_TTL_SECONDS,
    iss: new URL(options.issuer).origin,
    aud: REALTIME_TOKEN_AUDIENCE,
  });
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const signingInput = `${HEADER}.${payload}`;
  const token = `${signingInput}.${signature(signingInput, options.secret).toString("base64url")}`;
  return { token: realtimeTokenSchema.parse(token), claims };
}

export function verifyRealtimeToken(
  input: unknown,
  options: RealtimeTokenOptions,
): RealtimeTokenClaims {
  const token = realtimeTokenSchema.parse(input);
  const parts = token.split(".");
  const [header, payload, encodedSignature] = parts;
  if (parts.length !== 3 || header !== HEADER || !payload || !encodedSignature)
    throw new Error("Invalid token.");
  const actualSignature = decodeSegment(encodedSignature);
  const expectedSignature = signature(`${header}.${payload}`, options.secret);
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  )
    throw new Error("Invalid token.");
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
    decodeSegment(payload),
  );
  const json: unknown = JSON.parse(decoded);
  const claims = realtimeTokenClaimsSchema.parse(json);
  // Issued tokens have one canonical object representation. Reject duplicate
  // keys, extra whitespace and alternate encodings instead of normalizing them.
  if (JSON.stringify(claims) !== decoded) throw new Error("Invalid token.");
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  if (
    claims.iss !== new URL(options.issuer).origin ||
    claims.aud !== REALTIME_TOKEN_AUDIENCE ||
    claims.exp <= now ||
    claims.iat > now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > REALTIME_TOKEN_TTL_SECONDS
  )
    throw new Error("Invalid or expired token.");
  return claims;
}
