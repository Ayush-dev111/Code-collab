"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createProjectSchema,
  createdProjectResponseSchema,
  projectResponseSchema,
  type CreateProjectInput,
} from "@collab/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";

function ProjectNameDialog({
  project,
  onClose,
}: {
  project?: { id: string; name: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const online = useOnline();
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: CreateProjectInput) => {
      if (project)
        return apiRequest(
          `/api/projects/${project.id}`,
          projectResponseSchema,
          { method: "PATCH", body: input },
        );
      return apiRequest("/api/projects", createdProjectResponseSchema, {
        method: "POST",
        body: input,
      });
    },
    onSuccess: async ({ project: savedProject }) => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (project) {
        await queryClient.invalidateQueries({
          queryKey: ["project", project.id],
        });
        router.refresh();
      } else router.push(`/projects/${savedProject.id}`);
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !online) return;
    setValidationError(null);
    const parsed = createProjectSchema.safeParse({
      name: new FormData(event.currentTarget).get("name"),
    });
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Enter a project name.",
      );
      return;
    }
    mutation.mutate(parsed.data);
  }

  const error =
    validationError ?? (mutation.error ? errorMessage(mutation.error) : null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={project ? "Rename project" : "Create a project"}
      description={
        project
          ? "Give your shared workspace a new name."
          : "Start a shared workspace. You will be its owner."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label
            htmlFor="project-name"
            className="mb-1.5 block text-xs font-semibold text-foreground"
          >
            {project ? "Repository name" : "Repository name *"}
          </label>
          <Input
            id="project-name"
            name="name"
            defaultValue={project?.name ?? ""}
            placeholder="e.g. my-awesome-project"
            required
            maxLength={80}
            disabled={mutation.isPending}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "project-name-error" : undefined}
            className="h-8.5 text-xs font-mono"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Great repository names are short and memorable.
          </p>
        </div>
        {error && (
          <p
            id="project-name-error"
            role="alert"
            className="rounded-md border border-destructive/20 bg-danger-soft p-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {!online && (
          <p role="status" className="text-xs text-warning">
            Reconnect to save this repository.
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
            {mutation.isPending
              ? "Saving…"
              : project
                ? "Save changes"
                : "Create repository"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateProjectButton() {
  const [open, setOpen] = useState(false);
  const online = useOnline();
  return (
    <>
      <Button disabled={!online} onClick={() => setOpen(true)}>
        <Icon name="repo" className="size-3.5" />
        <span>New</span>
      </Button>
      {open && <ProjectNameDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function RenameProjectButton({
  project,
}: {
  project: { id: string; name: string };
}) {
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
        Rename
      </Button>
      {open && (
        <ProjectNameDialog project={project} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
