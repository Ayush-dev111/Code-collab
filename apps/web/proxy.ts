import { NextResponse, type NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";
import { contentSecurityPolicy } from "@/lib/security-policy";

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  if (request.nextUrl.pathname.startsWith("/projects")) {
    const session = await getAuth().api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true, disableRefresh: true },
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
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|monaco).*)"],
};
