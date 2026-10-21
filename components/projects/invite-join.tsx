"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  emptyInputSchema,
  invitePreviewResponseSchema,
  joinInviteResponseSchema,
} from "@/lib/shared";
import {
  apiRequest,
  ApiClientError,
  errorMessage,
  useOnline,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { RoleBadge } from "@/components/projects/role-badge";

export function InviteJoin({ code }: { code: string }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const query = useQuery({
    queryKey: ["invite", code],
    queryFn: ({ signal }) =>
      apiRequest(`/api/invites/${code}`, invitePreviewResponseSchema, {
        signal,
      }),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/invites/${code}/join`, joinInviteResponseSchema, {
        method: "POST",
        body: emptyInputSchema.parse({}),
      }),
    onSuccess: async ({ projectId }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.removeQueries({ queryKey: ["invite", code] });
      router.replace(`/projects/${projectId}`);
      router.refresh();
    },
  });
  const invite = query.data?.invite;
  const expired =
    query.error instanceof ApiClientError && query.error.status === 410;
  const unauthenticated =
    query.error instanceof ApiClientError && query.error.status === 401;

  return (
    <main className="mx-auto max-w-lg px-5 py-16 sm:py-24">
      <section className="rounded-2xl border bg-card p-7 shadow-sm sm:p-9">
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-2xl text-primary"
        >
          ↗
        </span>
        {query.isPending && (
          <div role="status" className="mt-6">
            <h1 className="text-xl font-semibold">Opening your invitation</h1>
            <p className="mt-3 text-sm text-muted-foreground">
              {query.fetchStatus === "paused"
                ? "Reconnect to view this invitation."
                : "Checking invitation details…"}
            </p>
          </div>
        )}
        {query.isError && (
          <div className="mt-6">
            <h1 className="text-2xl font-semibold">
              {expired
                ? "This invitation has expired"
                : unauthenticated
                  ? "Sign in to continue"
                  : "Unable to open this invitation"}
            </h1>
            <p
              role="alert"
              className="mt-3 text-sm leading-6 text-muted-foreground"
            >
              {errorMessage(query.error)}
            </p>
            {unauthenticated ? (
              <Link
                href={`/login?callbackURL=${encodeURIComponent(`/invite/${code}`)}`}
                className="mt-6 inline-block text-sm font-medium text-primary"
              >
                Sign in →
              </Link>
            ) : (
              <div className="mt-6 flex items-center gap-4">
                {!expired && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!online || query.isFetching}
                    onClick={() => void query.refetch()}
                  >
                    Try again
                  </Button>
                )}
                <Link
                  href="/projects"
                  className="text-sm font-medium text-primary"
                >
                  Your projects →
                </Link>
              </div>
            )}
          </div>
        )}
        {invite && (
          <div className="mt-6">
            <p className="text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
              You are invited
            </p>
            <h1 className="mt-3 break-words text-2xl font-semibold tracking-tight">
              Join {invite.projectName}
            </h1>
            <p className="mt-4 text-sm leading-7 text-muted-foreground">
              {invite.isMember
                ? "You are already a member of this project. Open the workspace to continue."
                : "Accept this invitation to enter the shared project workspace."}
            </p>
            {!invite.isMember && (
              <div className="mt-4 flex items-center gap-3 text-sm">
                <span className="text-muted-foreground">Your access</span>
                <RoleBadge role={invite.role} />
              </div>
            )}
            <p className="mt-4 text-xs text-muted-foreground">
              Link expires{" "}
              {new Intl.DateTimeFormat("en", {
                dateStyle: "medium",
                timeStyle: "short",
                timeZone: "Asia/Calcutta",
              }).format(new Date(invite.expiresAt))}{" "}
              IST
            </p>
            {mutation.error && (
              <p
                role="alert"
                className="mt-5 rounded-lg bg-danger-soft px-3 py-2 text-sm text-destructive"
              >
                {errorMessage(mutation.error)}
              </p>
            )}
            {!online && (
              <p role="status" className="mt-5 text-sm text-warning">
                Reconnect to join this project.
              </p>
            )}
            <div className="mt-7">
              {invite.isMember ? (
                <Link
                  href={`/projects/${invite.projectId}`}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                >
                  Open project →
                </Link>
              ) : (
                <Button
                  className="w-full"
                  disabled={!online || mutation.isPending}
                  onClick={() => mutation.mutate()}
                >
                  {mutation.isPending ? "Joining project…" : "Join project"}
                  <span aria-hidden="true">→</span>
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
      <Link
        href="/projects"
        className="mt-6 block text-center text-sm text-muted-foreground hover:text-primary"
      >
        ← Back to your projects
      </Link>
    </main>
  );
}
