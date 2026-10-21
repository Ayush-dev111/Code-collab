import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";
import { contentSecurityPolicy } from "@/lib/security-policy";

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  let refreshedCookies: string[] = [];
  if (request.nextUrl.pathname.startsWith("/projects")) {
    // Usually answered from the signed session cookie without a database
    // query. Better Auth returns a fresh cookie when the cached copy expires.
    const { headers: authHeaders, response: session } =
      await getAuth().api.getSession({
        headers: request.headers,
        returnHeaders: true,
      });
    if (!session) {
      const login = new URL("/login", request.url);
      login.searchParams.set(
        "callbackURL",
        request.nextUrl.pathname + request.nextUrl.search,
      );
      const response = NextResponse.redirect(login);
      response.headers.set("Content-Security-Policy", policy);
      return response;
    }
    refreshedCookies = authHeaders.getSetCookie();
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  for (const cookie of refreshedCookies)
    response.headers.append("Set-Cookie", cookie);
  return response;
}

export const config = {
  matcher: [
    "/((?!api|yjs|socket.io|_next/static|_next/image|favicon.ico|monaco).*)",
  ],
};
