"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  hasMinimumRole,
  projectResponseSchema,
  type ProjectDetails,
  type RealtimeUser,
  type TreeItem,
} from "@collab/shared";
import {
  apiRequest,
  ApiClientError,
  errorMessage,
  useOnline,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { RenameProjectButton } from "@/components/projects/project-name-dialog";
import { InviteProjectButton } from "@/components/projects/invite-dialog";
import { RoleBadge } from "@/components/projects/role-badge";
import { MemberList } from "@/components/workspace/member-list";
import { ProjectTree } from "@/components/tree/project-tree";
import { PageEditor } from "@/components/editor/page-editor";
import { CodeEditor } from "@/components/code/code-editor";
import { ProjectOnlineList } from "@/components/presence/project-online-list";
import {
  useProjectRealtime,
  type ProjectRealtime,
} from "@/lib/realtime-client";
import { ChatPanel } from "@/components/chat/chat-panel";
import { RealtimeNotice } from "./realtime-notice";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

function subscribeDesktop(callback: () => void) {
  const media = matchMedia("(min-width: 1024px)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

function ProjectSidebar({
  project,
  selectedItemId,
  realtime,
  onSelect,
}: {
  project: ProjectDetails;
  selectedItemId?: string | undefined;
  realtime: ProjectRealtime;
  onSelect: () => void;
}) {
  return (
    <aside
      aria-label="Project sidebar"
      className="flex h-full min-w-0 flex-col gap-4 rounded-md border border-border bg-sidebar p-3 shadow-xs"
    >
      <div className="flex items-center justify-between border-b border-border pb-2.5">
        <div className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-mono font-medium shadow-2xs">
          <Icon name="gitBranch" className="size-3 text-muted-foreground" />
          <span>main</span>
        </div>
        <span className="text-[11px] text-muted-foreground font-mono">1 branch</span>
      </div>
      <Link
        href={`/projects/${project.id}`}
        aria-current={!selectedItemId ? "page" : undefined}
        onNavigate={onSelect}
        className={cn(
          "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
          !selectedItemId
            ? "bg-secondary text-foreground font-semibold border border-border/60"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
        )}
      >
        <Icon name="repo" className="size-3.5 text-muted-foreground" />
        Repository overview
      </Link>
      <ProjectTree
        projectId={project.id}
        role={project.role}
        selectedItemId={selectedItemId}
        realtime={realtime}
        onSelect={onSelect}
      />
      <ProjectOnlineList projectId={project.id} realtime={realtime} />
      <div className="border-t border-border pt-4 mt-auto">
        <MemberList members={project.members} />
      </div>
    </aside>
  );
}

function RoomOverview({ project }: { project: ProjectDetails }) {
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
          Welcome to the <strong>{project.name}</strong> collaborative workspace. Bring your team&apos;s ideas to life with real-time shared documents, code execution, and persistent discussions.
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
            <div key={title} className="rounded-md border border-border p-4 bg-secondary/20">
              <span className="flex size-7 items-center justify-center rounded-md border border-border bg-card text-muted-foreground">
                <Icon name={icon as "file" | "code" | "chat"} className="size-3.5" />
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

export function RoomShell({
  initialProject,
  initialItem,
  currentUser,
  currentUserId,
}: {
  initialProject: ProjectDetails;
  initialItem?: TreeItem;
  currentUser?: RealtimeUser;
  currentUserId?: string;
}) {
  const [panel, setPanel] = useState<"files" | "workspace" | "chat">(
    "workspace",
  );
  const online = useOnline();
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => matchMedia("(min-width: 1024px)").matches,
    () => true,
  );
  const realtime = useProjectRealtime(
    initialProject.id,
    initialItem?.id ?? null,
  );
  const query = useQuery({
    queryKey: ["project", initialProject.id],
    queryFn: ({ signal }) =>
      apiRequest(`/api/projects/${initialProject.id}`, projectResponseSchema, {
        signal,
      }),
    initialData: { project: initialProject },
  });
  const project = query.data.project;
  const denied =
    query.error instanceof ApiClientError &&
    [401, 403, 404].includes(query.error.status);
  if (denied)
    return (
      <main className="mx-auto max-w-lg px-6 py-20">
        <h1 className="text-2xl font-semibold">This project is unavailable</h1>
        <p role="alert" className="mt-3 text-sm text-muted-foreground">
          {errorMessage(query.error)}
        </p>
        <Link
          href="/projects"
          className="mt-6 inline-block text-sm font-medium text-primary"
        >
          Back to projects
        </Link>
      </main>
    );
  return (
    <main className="mx-auto max-w-[1800px]">
      <header className="border-b border-border bg-sidebar/50 px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 flex-wrap">
            <Icon name="repo" className="size-4.5 text-muted-foreground shrink-0" />
            <Link
              href="/projects"
              className="text-sm sm:text-base text-blue hover:underline font-normal"
            >
              workspace
            </Link>
            <span className="text-muted-foreground/60">/</span>
            <h1 className="text-sm sm:text-base font-semibold text-blue hover:underline tracking-tight truncate max-w-[50vw]">
              {project.name}
            </h1>
            <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Public
            </span>
            <RoleBadge role={project.role} />
          </div>
          <div className="flex items-center gap-2">
            <span className="mr-2 hidden items-center gap-1.5 text-xs text-muted-foreground md:flex">
              <span
                className={cn(
                  "size-2 rounded-full",
                  realtime.connected ? "bg-success" : "bg-warning",
                )}
              />
              {realtime.connected ? "Live" : "Connecting"}
            </span>
            {hasMinimumRole(project.role, "EDITOR") && (
              <RenameProjectButton project={project} />
            )}
            {project.role === "OWNER" && (
              <InviteProjectButton projectId={project.id} />
            )}
          </div>
        </div>
      </header>
      <RealtimeNotice realtime={realtime} />
      {query.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/20 bg-warning-soft px-6 py-3 text-sm text-warning"
        >
          <p>{errorMessage(query.error)} Displaying the last loaded project.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!online || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      )}
      <div
        role="group"
        aria-label="Workspace panels"
        className="mx-4 mb-4 flex gap-5 overflow-x-auto border-b lg:hidden"
      >
        {(
          [
            { value: "files", label: "Files & team", icon: "folder" },
            { value: "workspace", label: "Workspace", icon: "grid" },
            { value: "chat", label: "Team chat", icon: "chat" },
          ] as const
        ).map(({ value, label, icon }) => (
          <button
            type="button"
            key={value}
            className="workspace-tab"
            aria-label={label}
            aria-pressed={panel === value}
            aria-controls={`panel-${value}`}
            onClick={() => setPanel(value)}
          >
            <Icon name={icon} />
            <span className="sm:hidden">
              {value === "files" ? "Files" : value === "chat" ? "Chat" : label}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
      <div className="grid min-h-[calc(100dvh-11rem)] items-stretch gap-4 px-4 pb-5 lg:grid-cols-[15rem_minmax(0,1fr)] lg:px-6 xl:grid-cols-[15rem_minmax(0,1fr)_18rem] 2xl:grid-cols-[16rem_minmax(0,1fr)_20rem]">
        <div
          id="panel-files"
          className={cn(
            panel !== "files" && "hidden",
            "lg:row-span-2 lg:block xl:row-span-1",
          )}
        >
          <ProjectSidebar
            project={project}
            selectedItemId={initialItem?.id}
            realtime={realtime}
            onSelect={() => setPanel("workspace")}
          />
        </div>
        <div
          id="panel-workspace"
          className={cn(
            "min-w-0",
            panel !== "workspace" && "hidden",
            "lg:block",
          )}
        >
          {initialItem?.type === "CODE" && currentUser ? (
            <CodeEditor
              key={initialItem.id}
              projectId={project.id}
              initialItem={initialItem}
              user={currentUser}
              role={project.role}
            />
          ) : initialItem && currentUser ? (
            <PageEditor
              key={initialItem.id}
              projectId={project.id}
              initialItem={initialItem}
              user={currentUser}
              role={project.role}
            />
          ) : (
            <RoomOverview project={project} />
          )}
        </div>
        <div
          id="panel-chat"
          className={cn(
            "min-w-0",
            panel !== "chat" && "hidden",
            "lg:col-start-2 lg:block xl:col-start-auto",
          )}
        >
          <ChatPanel
            key={project.id}
            projectId={project.id}
            role={project.role}
            userId={currentUser?.id ?? currentUserId}
            realtime={realtime}
            active={desktop || panel === "chat"}
          />
        </div>
      </div>
    </main>
  );
}
