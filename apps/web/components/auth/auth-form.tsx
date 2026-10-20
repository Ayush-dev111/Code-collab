"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signInSchema, signUpSchema } from "@collab/shared";
import { authClient } from "@/lib/auth-client";
import { errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SocialSignIn } from "@/components/auth/social-sign-in";

export function AuthForm({
  mode,
  callbackURL,
  providers,
}: {
  mode: "login" | "signup";
  callbackURL: string;
  providers: { google: boolean; github: boolean };
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signingUp = mode === "signup";
  const otherHref = `${signingUp ? "/login" : "/signup"}?callbackURL=${encodeURIComponent(callbackURL)}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || pending) return;
    setError(null);
    const formData = new FormData(event.currentTarget);
    const fields = {
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
      callbackURL,
    };
    const parsed = signingUp
      ? signUpSchema.safeParse(fields)
      : signInSchema.safeParse({
          email: fields.email,
          password: fields.password,
          callbackURL,
          rememberMe: formData.get("rememberMe") === "on",
        });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check your details.");
      return;
    }
    setPending(true);
    try {
      const result = signingUp
        ? await authClient.signUp.email(signUpSchema.parse(fields))
        : await authClient.signIn.email(
            signInSchema.parse({
              email: fields.email,
              password: fields.password,
              callbackURL,
              rememberMe: formData.get("rememberMe") === "on",
            }),
          );
      if (result.error) {
        setError(
          result.error.message ?? "Unable to sign in. Please try again.",
        );
        return;
      }
      queryClient.clear();
      router.replace(callbackURL);
      router.refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 className="text-2xl font-light text-center tracking-tight text-foreground mb-4">
        {signingUp ? "Sign up for Collab" : "Sign in to Collab"}
      </h1>

      <div className="rounded-md border border-border bg-card p-5 shadow-xs">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {signingUp && (
            <div>
              <label htmlFor="name" className="mb-1.5 block text-xs font-medium text-foreground">
                Username
              </label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                required
                maxLength={80}
                placeholder="mona-lisa"
                disabled={pending}
                className="h-8.5 text-xs"
              />
            </div>
          )}
          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-foreground">
              Email address
            </label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@domain.com"
              disabled={pending}
              className="h-8.5 text-xs"
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="password" className="block text-xs font-medium text-foreground">
                Password
              </label>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete={signingUp ? "new-password" : "current-password"}
              required
              minLength={signingUp ? 10 : 1}
              maxLength={128}
              placeholder={
                signingUp ? "At least 10 characters" : "Enter password"
              }
              disabled={pending}
              className="h-8.5 text-xs"
            />
          </div>
          {!signingUp && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground pt-0.5">
              <input
                name="rememberMe"
                type="checkbox"
                defaultChecked
                disabled={pending}
                className="size-3.5 rounded border-border accent-primary"
              />
              Keep me signed in
            </label>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-danger-soft px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
          {!online && (
            <p role="status" className="text-xs text-warning">
              Reconnect to sign in or create an account.
            </p>
          )}
          <Button
            type="submit"
            variant="primary"
            className="w-full mt-2 font-medium"
            disabled={pending || !online}
          >
            {pending
              ? signingUp
                ? "Creating account…"
                : "Signing in…"
              : signingUp
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>

        <SocialSignIn
          providers={providers}
          callbackURL={callbackURL}
          disabled={pending}
        />
      </div>

      <div className="mt-4 rounded-md border border-border bg-card p-4 text-center text-xs text-muted-foreground shadow-xs">
        {signingUp ? "Already have an account?" : "New to Collab?"}{" "}
        <Link
          className="font-medium text-blue hover:underline"
          href={otherHref}
        >
          {signingUp ? "Sign in" : "Create an account"}
        </Link>
        .
      </div>
    </>
  );
}
