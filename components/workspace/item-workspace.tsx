"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { itemsResponseSchema } from "@/lib/shared";
import { apiRequest } from "@/lib/api-client";
import { itemsQueryKey } from "@/components/tree/tree-utils";
import { PageEditor } from "@/components/editor/page-editor";
import { CodeEditor } from "@/components/code/code-editor";
import { useProject } from "./project-context";

export function ItemWorkspace({ itemId }: { itemId: string }) {
  const { project, user } = useProject();
  const router = useRouter();
  const items = useQuery({
    queryKey: itemsQueryKey(project.id),
    queryFn: ({ signal }) =>
      apiRequest(`/api/projects/${project.id}/items`, itemsResponseSchema, {
        signal,
      }),
  });
  const item = items.data?.items.find((candidate) => candidate.id === itemId);
  useEffect(() => {
    if (item?.type === "FOLDER") router.replace(`/projects/${project.id}`);
  }, [item?.type, project.id, router]);
  if (!item || item.type === "FOLDER")
    return (
      <section
        role="status"
        className="min-h-full rounded-md border border-border bg-card p-6 text-sm text-muted-foreground"
      >
        {items.isPending
          ? "Opening shared page..."
          : items.isError
            ? "This page could not be loaded. Check your connection."
            : "This page is no longer available."}
      </section>
    );
  const Editor = item.type === "CODE" ? CodeEditor : PageEditor;
  return (
    <Editor
      key={item.id}
      projectId={project.id}
      initialItem={item}
      user={user}
      role={project.role}
    />
  );
}
