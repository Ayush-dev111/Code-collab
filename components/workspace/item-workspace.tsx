"use client";

import type { TreeItem } from "@/lib/shared";
import { PageEditor } from "@/components/editor/page-editor";
import { CodeEditor } from "@/components/code/code-editor";
import { useProject } from "./project-context";

export function ItemWorkspace({ item }: { item: TreeItem }) {
  const { project, user } = useProject();
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
