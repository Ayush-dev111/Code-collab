"use client";

import { useState } from "react";
import { socialSignInSchema } from "@collab/shared";
import { authClient } from "@/lib/auth-client";
import { errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function SocialSignIn({
  providers,
  callbackURL,
  disabled,
}: {
  providers: { google: boolean; github: boolean };
  callbackURL: string;
  disabled: boolean;
}) {
  const online = useOnline();
  const [pending, setPending] = useState<"google" | "github" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasProvider = providers.google || providers.github;

  async function signIn(provider: "google" | "github") {
    setError(null);
    setPending(provider);
    try {
      const payload = socialSignInSchema.parse({ provider, callbackURL });
      const result = await authClient.signIn.social(payload);
      if (result.error)
        setError(
          result.error.message ?? "Unable to start sign in. Please try again.",
        );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-5 pt-4 border-t border-border">
      <div className="flex items-center gap-3 text-xs text-muted-foreground mb-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/80">or continue with</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(["github", "google"] as const).map((provider) => (
          <Button
            key={provider}
            variant="outline"
            className="h-8.5 text-xs font-normal"
            disabled={
              disabled || !online || !providers[provider] || pending !== null
            }
            onClick={() => void signIn(provider)}
            title={
              !providers[provider]
                ? "This provider is not configured yet"
                : undefined
            }
          >
            {provider === "github" ? (
              <Icon name="github" className="size-4 mr-1.5 fill-current" />
            ) : (
              <span aria-hidden="true" className="font-semibold mr-1.5 text-xs">
                G
              </span>
            )}
            {pending === provider
              ? "Connecting…"
              : provider === "github"
                ? "GitHub"
                : "Google"}
          </Button>
        ))}
      </div>
      {!hasProvider && (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          Social sign in is not configured for this workspace yet.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
