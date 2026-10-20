"use client";

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  createInviteSchema,
  inviteResponseSchema,
  type CreateInviteInput,
} from "@collab/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function InviteDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const online = useOnline();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle",
  );
  const mutation = useMutation({
    mutationFn: (input: CreateInviteInput) =>
      apiRequest(`/api/projects/${projectId}/invites`, inviteResponseSchema, {
        method: "POST",
        body: input,
      }),
  });
  const invite = mutation.data?.invite;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!online || mutation.isPending) return;
    setValidationError(null);
    const form = new FormData(event.currentTarget);
    const parsed = createInviteSchema.safeParse({
      role: form.get("role"),
      expiresInDays: Number(form.get("expiresInDays")),
    });
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Check the invite settings.",
      );
      return;
    }
    mutation.mutate(parsed.data);
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  const error =
    validationError ?? (mutation.error ? errorMessage(mutation.error) : null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Invite your team"
      description="Share a link to give someone access to this project."
    >
      {invite ? (
        <div className="space-y-4">
          <p
            role="status"
            className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-xs text-success"
          >
            Your invitation link is ready.
          </p>
          <div>
            <label
              htmlFor="invite-url"
              className="mb-1.5 block text-xs font-semibold text-foreground"
            >
              Invitation link
            </label>
            <Input
              id="invite-url"
              value={invite.url}
              readOnly
              className="h-8.5 text-xs font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
            <div className="mt-3 flex items-center gap-3">
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copyStatus === "copied" ? "Copied!" : "Copy link"}
              </Button>
              <a
                href={invite.url}
                className="text-xs font-medium text-blue hover:underline"
              >
                Open invitation ↗
              </a>
            </div>
            {copyStatus === "error" && (
              <p role="alert" className="mt-2 text-xs text-destructive">
                Select and copy the link above. Clipboard access was
                unavailable.
              </p>
            )}
          </div>
          <p className="text-[11px] leading-5 text-muted-foreground">
            Grants {invite.role.toLowerCase()} access. Expires{" "}
            {new Intl.DateTimeFormat("en", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "Asia/Calcutta",
            }).format(new Date(invite.expiresAt))}{" "}
            IST. Anyone with this link can join after signing in.
          </p>
          <div className="flex justify-end pt-2 border-t border-border">
            <Button size="sm" variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="invite-role"
              className="mb-1.5 block text-xs font-semibold text-foreground"
            >
              Access level
            </label>
            <select
              id="invite-role"
              name="role"
              defaultValue="EDITOR"
              disabled={mutation.isPending}
              className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
            >
              <option value="EDITOR">Editor — can make changes</option>
              <option value="VIEWER">Viewer — can view the project</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="invite-expiry"
              className="mb-1.5 block text-xs font-semibold text-foreground"
            >
              Link expires in
            </label>
            <select
              id="invite-expiry"
              name="expiresInDays"
              defaultValue="7"
              disabled={mutation.isPending}
              className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
            >
              <option value="7">7 days</option>
              <option value="30">30 days</option>
            </select>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-destructive/20 bg-danger-soft p-2 text-xs text-destructive">
              {error}
            </p>
          )}
          {!online && (
            <p role="status" className="text-xs text-warning">
              Reconnect to create an invitation.
            </p>
          )}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="outline" size="sm" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={mutation.isPending || !online}
            >
              {mutation.isPending ? "Creating link…" : "Create invite link"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export function InviteProjectButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={!online}
        onClick={() => setOpen(true)}
      >
        Invite members
      </Button>
      {open && (
        <InviteDialog projectId={projectId} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
