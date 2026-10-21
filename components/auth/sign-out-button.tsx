"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function SignOutButton() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setPending(true);
    setError(null);
    try {
      const result = await authClient.signOut();
      if (result.error)
        throw new Error(result.error.message ?? "Unable to sign out.");
      queryClient.clear();
      router.replace("/login");
      router.refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="text-right">
      <Button
        size="sm"
        variant="ghost"
        aria-label="Sign out"
        title="Sign out"
        disabled={pending || !online}
        onClick={() => void signOut()}
      >
        <Icon name="logout" />
        <span className="hidden xl:inline">
          {pending ? "Signing out…" : "Sign out"}
        </span>
      </Button>
      {error && (
        <p role="alert" className="max-w-52 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
