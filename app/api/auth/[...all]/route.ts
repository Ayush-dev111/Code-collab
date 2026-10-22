import { z } from "zod";
import {
  authQuerySchema,
  authSignInSchema,
  authSignUpSchema,
  authSocialSignInSchema,
  emptyInputSchema,
} from "@/lib/shared";
import { toNextJsHandler } from "better-auth/next-js";
import {
  ApiError,
  assertSameOrigin,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { getAuth, getAuthProviderAvailability } from "@/lib/auth";
import { requireSession } from "@/lib/permissions";

export const runtime = "nodejs";

const authPrefix = "/api/auth/";
const getPaths = new Set([
  "get-session",
  "callback/google",
  "callback/github",
  "error",
]);
// The hosted Better Auth dashboard calls these from its own server with a
// signed token that the dash plugin verifies itself.
const isDashboardPath = (path: string) => /^(dash|events)\//.test(path);

async function forwardToAuth(
  request: Request,
  method: "GET" | "POST",
  body?: unknown,
) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  // A hosting proxy's request id would make the dash plugin look up visitor
  // data remotely on every session check; it only uses its own browser SDK's.
  headers.delete("x-request-id");
  const response = await toNextJsHandler(getAuth())[method](
    new Request(request.url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function GET(request: Request) {
  return withApiError(async () => {
    const path = new URL(request.url).pathname.slice(authPrefix.length);
    if (isDashboardPath(path)) return forwardToAuth(request, "GET");
    if (!getPaths.has(path))
      throw new ApiError(
        404,
        "NOT_FOUND",
        "This authentication route is not enabled.",
      );
    parseQuery(request, authQuerySchema);
    return forwardToAuth(request, "GET");
  });
}

export function POST(request: Request) {
  return withApiError(async () => {
    const path = new URL(request.url).pathname.slice(authPrefix.length);
    if (isDashboardPath(path))
      return forwardToAuth(
        request,
        "POST",
        request.body
          ? await readJson(request, z.unknown(), 1024 * 1024)
          : undefined,
      );
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    let body: unknown;
    switch (path) {
      case "sign-up/email":
        body = await readJson(request, authSignUpSchema);
        break;
      case "sign-in/email":
        body = await readJson(request, authSignInSchema);
        break;
      case "sign-in/social": {
        const input = await readJson(request, authSocialSignInSchema);
        if (!getAuthProviderAvailability()[input.provider]) {
          throw new ApiError(
            503,
            "PROVIDER_UNAVAILABLE",
            "This sign-in provider has not been configured.",
          );
        }
        body = input;
        break;
      }
      case "sign-out":
        await requireSession(request.headers);
        body = await readJson(request, emptyInputSchema);
        break;
      default:
        throw new ApiError(
          404,
          "NOT_FOUND",
          "This authentication route is not enabled.",
        );
    }
    // Forward only validated fields, including trimmed names/emails and safe callback paths.
    return forwardToAuth(request, "POST", body);
  });
}
