import { apiErrorSchema, authEnvironmentSchema } from "@/lib/shared";
import { randomUUID } from "node:crypto";
import { RateLimitError } from "@/lib/rate-limit";
import { log } from "@/lib/logging";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface SafeParser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string }[] } };
}

export function parseInput<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const message = result.error.issues[0]?.message || "Invalid input.";
    throw new ApiError(400, "INVALID_INPUT", message.slice(0, 300));
  }
  return result.data;
}

export function parseQuery<T>(request: Request, schema: SafeParser<T>): T {
  const input: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (Object.hasOwn(input, key)) {
      throw new ApiError(
        400,
        "INVALID_INPUT",
        "Duplicate query parameters are not allowed.",
      );
    }
    Object.defineProperty(input, key, {
      value,
      enumerable: true,
      configurable: true,
    });
  }
  return parseInput(schema, input);
}

let cachedOrigin: string | undefined;
function getApplicationOrigin(): string {
  if (!cachedOrigin) {
    const environment = authEnvironmentSchema.parse(process.env);
    cachedOrigin = new URL(environment.BETTER_AUTH_URL).origin;
  }
  return cachedOrigin;
}

export function assertSameOrigin(request: Request): void {
  if (request.headers.get("origin") !== getApplicationOrigin()) {
    throw new ApiError(
      403,
      "INVALID_ORIGIN",
      "This request must come from the application origin.",
    );
  }
}

const MAX_BODY_BYTES = 16 * 1024;

export async function readJson<T>(
  request: Request,
  schema: SafeParser<T>,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<T> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Send a JSON request body.",
    );
  }
  if (!request.body)
    throw new ApiError(400, "INVALID_INPUT", "A JSON body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBodyBytes) {
        await reader.cancel();
        throw new ApiError(
          413,
          "BODY_TOO_LARGE",
          `Request bodies must be at most ${Math.floor(maxBodyBytes / 1024)} KiB.`,
        );
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "The request body must be valid UTF-8 JSON.",
    );
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "The request body must be valid JSON.",
    );
  }
  return parseInput(schema, input);
}

export function jsonResponse<T>(
  schema: SafeParser<T>,
  data: unknown,
  status = 200,
): Response {
  const result = schema.safeParse(data);
  if (!result.success)
    throw new ApiError(
      500,
      "INVALID_RESPONSE",
      "The server could not prepare its response.",
    );
  return Response.json(result.data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function withApiError(
  handler: () => Promise<Response>,
): Promise<Response> {
  const requestId = randomUUID();
  try {
    const response = await handler();
    response.headers.set("X-Request-Id", requestId);
    return response;
  } catch (error) {
    let response: Response;
    if (error instanceof RateLimitError) {
      response = jsonResponse(
        apiErrorSchema,
        { code: "RATE_LIMITED", message: error.message },
        429,
      );
      response.headers.set("Retry-After", String(error.retryAfter));
    } else if (error instanceof ApiError) {
      response = jsonResponse(
        apiErrorSchema,
        { code: error.code, message: error.message },
        error.status,
      );
      if (error.retryAfter !== undefined)
        response.headers.set("Retry-After", String(error.retryAfter));
    } else {
      log("error", "request.failed", { requestId, code: "INTERNAL_ERROR" });
      console.error(error);
      response = jsonResponse(
        apiErrorSchema,
        {
          code: "INTERNAL_ERROR",
          message:
            "The server could not complete this request. Please try again.",
        },
        500,
      );
    }
    response.headers.set("X-Request-Id", requestId);
    return response;
  }
}
