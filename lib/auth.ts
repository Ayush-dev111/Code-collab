import { getDatabase } from "@/lib/db";
import { authEnvironmentSchema } from "@/lib/shared";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

let cachedAuthEnv: ReturnType<typeof authEnvironmentSchema.parse> | undefined;
export function getAuthEnvironment() {
  return (cachedAuthEnv ??= authEnvironmentSchema.parse(process.env));
}

export function getAuthProviderAvailability() {
  const environment = getAuthEnvironment();
  return {
    google: Boolean(
      environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET,
    ),
    github: Boolean(
      environment.GITHUB_CLIENT_ID && environment.GITHUB_CLIENT_SECRET,
    ),
  };
}

function createAuthInstance() {
  const environment = getAuthEnvironment();
  return betterAuth({
    appName: "Collab",
    baseURL: environment.BETTER_AUTH_URL,
    secret: environment.BETTER_AUTH_SECRET,
    database: prismaAdapter(getDatabase(), { provider: "postgresql" }),
    trustedOrigins: [new URL(environment.BETTER_AUTH_URL).origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
    },
    socialProviders: {
      ...(environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: environment.GOOGLE_CLIENT_ID,
              clientSecret: environment.GOOGLE_CLIENT_SECRET,
            },
          }
        : {}),
      ...(environment.GITHUB_CLIENT_ID && environment.GITHUB_CLIENT_SECRET
        ? {
            github: {
              clientId: environment.GITHUB_CLIENT_ID,
              clientSecret: environment.GITHUB_CLIENT_SECRET,
            },
          }
        : {}),
    },
    // The session is read from a signed cookie instead of the database on
    // most requests. A signed-out or revoked session stops working within
    // this window; the proxy refreshes the cookie on every page navigation.
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 10 * 60,
      },
    },
    plugins: [nextCookies()],
  });
}

let authInstance: ReturnType<typeof createAuthInstance> | undefined;

// Do not require secrets or open a database connection while compiling Next.js.
export function getAuth() {
  authInstance ??= createAuthInstance();
  return authInstance;
}
