import { betterAuth } from "better-auth";

// Schema generation only. Phase 1 will configure and expose authentication.
export const auth = betterAuth({
  appName: "Collab",
  baseURL: "http://127.0.0.1:3000",
  emailAndPassword: { enabled: true },
});
