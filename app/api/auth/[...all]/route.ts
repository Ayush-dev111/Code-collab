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

export function GET(request: Request) {
  return withApiError(async () => {
    const path = new URL(request.url).pathname.slice(authPrefix.length);
    if (!getPaths.has(path))
      throw new ApiError(
        404,
        "NOT_FOUND",
        "This authentication route is not enabled.",
      );
    parseQuery(request, authQuerySchema);
    const response = await toNextJsHandler(getAuth()).GET(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}

export function POST(request: Request) {
  return withApiError(async () => {
    const path = new URL(request.url).pathname.slice(authPrefix.length);
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
    const requestHeaders = new Headers(request.headers);
    requestHeaders.delete("content-length");
    const validatedRequest = new Request(request.url, {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    const response = await toNextJsHandler(getAuth()).POST(validatedRequest);
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
}
