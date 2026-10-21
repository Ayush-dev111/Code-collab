"use client";

import { Icon } from "@/components/ui/icon";
import { useProject } from "./project-context";

export function RoomOverview() {
  const { project } = useProject();
  return (
    <section
      aria-labelledby="room-title"
      className="min-h-full min-w-0 rounded-md border border-border bg-card shadow-xs overflow-hidden"
    >
      <div className="flex items-center justify-between border-b border-border bg-secondary/60 px-4 py-2.5 text-xs font-semibold">
        <div className="flex items-center gap-2 text-foreground font-mono">
          <Icon name="file" className="size-3.5 text-muted-foreground" />
          README.md
        </div>
        <span className="text-[11px] text-muted-foreground font-normal">
          Markdown preview
        </span>
      </div>
      <div className="p-6 sm:p-8">
        <h1
          id="room-title"
          className="border-b border-border pb-3 text-2xl sm:text-3xl font-semibold tracking-tight"
        >
          {project.name}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          Welcome to the <strong>{project.name}</strong> collaborative
          workspace. Bring your team&apos;s ideas to life with real-time shared
          documents, code execution, and persistent discussions.
        </p>

        <div className="mt-6 rounded-md border-l-4 border-blue bg-blue-soft/30 p-4">
          <p className="text-xs font-semibold text-blue">Access level</p>
          <p className="mt-1 text-xs text-foreground leading-relaxed">
            {project.role === "VIEWER"
              ? "You have read-only access. You can explore documents, inspect code, and view execution outputs."
              : project.role === "OWNER"
                ? "You are the repository administrator. You have full access to manage files, invite collaborators, and rename projects."
                : "You have write access. You can create and edit documents, modify code files, and trigger execution runs."}
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            {
              icon: "file",
              title: "Rich Documentation",
              text: "Collaborative markdown documents with instant Yjs syncing.",
            },
            {
              icon: "code",
              title: "Code & Execution",
              text: "Monaco editor with sandboxed multi-language execution.",
            },
            {
              icon: "chat",
              title: "Team Discussions",
              text: "Context-aware live room chat with typing presence.",
            },
          ].map(({ icon, title, text }) => (
            <div
              key={title}
              className="rounded-md border border-border p-4 bg-secondary/20"
            >
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                <Icon
                  name={icon as "file" | "code" | "chat"}
                  className="size-3.5"
                />
              </span>
              <h3 className="mt-3 text-xs font-semibold">{title}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {text}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-8 pt-6 border-t border-border flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Icon name="lock" className="size-3.5" />
            Private workspace
          </span>
          <span>Powered by Collab Engine</span>
        </div>
      </div>
    </section>
  );
}
