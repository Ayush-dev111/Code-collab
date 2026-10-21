"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { projectsResponseSchema } from "@/lib/shared";
import {
  apiRequest,
  ApiClientError,
  errorMessage,
  useOnline,
} from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { CreateProjectButton } from "@/components/projects/project-name-dialog";
import { RoleBadge } from "@/components/projects/role-badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function ProjectList() {
  const [filter, setFilter] = useState<"all" | "owned" | "shared">("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const online = useOnline();
  const query = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) =>
      apiRequest("/api/projects", projectsResponseSchema, { signal }),
  });
  const projects = query.data?.projects;
  const unauthenticated =
    query.error instanceof ApiClientError && query.error.status === 401;
  const owned =
    projects?.filter((project) => project.role === "OWNER").length ?? 0;
  const shared = (projects?.length ?? 0) - owned;
  const filtered = projects?.filter(
    (project) =>
      (filter === "all" ||
        (filter === "owned"
          ? project.role === "OWNER"
          : project.role !== "OWNER")) &&
      project.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2.5">
            <Icon name="repo" className="size-5 text-muted-foreground" />
            Repositories
            <span className="rounded-full border border-border bg-secondary/80 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {projects?.length ?? 0}
            </span>
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Manage your collaborative spaces, documents, code files, and teams.
          </p>
        </div>
        <CreateProjectButton />
      </div>

      <section className="mt-6" aria-labelledby="projects-heading">
        <h2 id="projects-heading" className="sr-only">
          Repositories list
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-1 min-w-[240px] max-w-md items-center relative">
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
            />
            <Input
              aria-label="Find a repository"
              placeholder="Find a repository…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-8 pl-9 text-xs sm:text-sm bg-card"
            />
          </div>

          <div className="flex items-center gap-2">
            <div
              role="group"
              aria-label="Filter repositories"
              className="inline-flex rounded-md border border-border bg-card p-0.5"
            >
              {[
                { value: "all", label: "All", count: projects?.length ?? 0 },
                { value: "owned", label: "Owned", count: owned },
                { value: "shared", label: "Shared", count: shared },
              ].map(({ value, label, count }) => (
                <button
                  type="button"
                  key={value}
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded transition-colors",
                    filter === value
                      ? "bg-secondary text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setFilter(value as typeof filter)}
                >
                  <span>{label}</span>
                  <span className="rounded-full bg-border/50 px-1.5 py-0.2 text-[10px] text-muted-foreground">
                    {count}
                  </span>
                </button>
              ))}
            </div>

            <div
              role="group"
              aria-label="Repository view"
              className="flex shrink-0 gap-0.5 rounded-md border border-border bg-card p-0.5"
            >
              {(["grid", "list"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  aria-label={`${mode === "grid" ? "Grid" : "List"} view`}
                  aria-pressed={view === mode}
                  onClick={() => setView(mode)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded",
                    view === mode
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon name={mode} className="size-3.5" />
                </button>
              ))}
            </div>
          </div>
        </div>

        {query.isPending && (
          <div
            role="status"
            className="py-14 text-center text-sm text-muted-foreground"
          >
            {query.fetchStatus === "paused"
              ? "Reconnect to load your projects."
              : "Loading projects…"}
          </div>
        )}
        {query.isError && (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-destructive/20 bg-danger-soft p-5"
          >
            <p className="text-sm text-destructive">
              {unauthenticated
                ? "Your session has ended. Sign in to continue."
                : errorMessage(query.error)}
            </p>
            {unauthenticated ? (
              <Link
                href="/login?callbackURL=%2Fprojects"
                className="mt-3 inline-block text-sm font-medium text-primary"
              >
                Sign in →
              </Link>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!online || query.isFetching}
                className="mt-3"
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            )}
          </div>
        )}
        {projects?.length === 0 && (
          <section className="mt-8 rounded-2xl border border-dashed bg-card px-6 py-16 text-center">
            <div
              aria-hidden="true"
              className="mx-auto flex size-14 items-center justify-center rounded-xl bg-primary/10 text-2xl text-primary"
            >
              <Icon name="folder" className="size-7" />
            </div>
            <h2 className="mt-5 text-lg font-semibold">
              Your first project starts here
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
              Create a space for your team, or join a project using an
              invitation link.
            </p>
            <div className="mt-6">
              <CreateProjectButton />
            </div>
          </section>
        )}
        {projects && projects.length > 0 && filtered?.length === 0 && (
          <div className="mt-6 rounded-2xl border border-dashed bg-card px-6 py-14 text-center">
            <Icon
              name="search"
              className="mx-auto size-7 text-muted-foreground"
            />
            <h3 className="mt-4 text-lg font-semibold">No projects found</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Try a different search or choose another filter.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-5"
              onClick={() => {
                setSearch("");
                setFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        )}
        {filtered && filtered.length > 0 && (
          <div
            className={cn(
              "mt-5",
              view === "grid"
                ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
                : "divide-y divide-border",
            )}
          >
            {filtered.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className={cn(
                  "group block text-foreground transition-colors",
                  view === "grid"
                    ? "rounded-md border border-border bg-card p-4 hover:border-muted-foreground/50 shadow-xs flex flex-col justify-between min-h-[140px]"
                    : "py-4 hover:bg-secondary/30 px-2 rounded-md",
                )}
              >
                {view === "grid" ? (
                  <>
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon
                            name="repo"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                          <h3
                            className="truncate text-sm font-semibold text-blue group-hover:underline"
                            title={project.name}
                          >
                            {project.name}
                          </h3>
                        </div>
                        <RoleBadge role={project.role} />
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                        {project.role === "OWNER"
                          ? "Primary workspace repository with shared documents and code."
                          : "Collaborative repository workspace."}
                      </p>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-[11px] text-muted-foreground border-t border-border/50 pt-2.5">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2.5 rounded-full bg-[#3178c6]" />
                          TypeScript
                        </span>
                        <span className="flex items-center gap-1">
                          <Icon name="star" className="size-3" />0
                        </span>
                      </div>
                      <span>
                        {new Intl.DateTimeFormat("en", {
                          month: "short",
                          day: "numeric",
                        }).format(new Date(project.createdAt))}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <Icon
                          name="repo"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <h3 className="text-base font-semibold text-blue group-hover:underline">
                          {project.name}
                        </h3>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          Public
                        </span>
                        <RoleBadge role={project.role} />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {project.role === "OWNER"
                          ? "Primary workspace repository with shared documents and code."
                          : "Collaborative repository workspace."}
                      </p>
                      <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1.5">
                          <span className="size-2.5 rounded-full bg-[#3178c6]" />
                          TypeScript
                        </span>
                        <span>
                          Updated on{" "}
                          {new Intl.DateTimeFormat("en", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          }).format(new Date(project.createdAt))}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="hidden sm:inline-flex pointer-events-none"
                    >
                      <Icon name="star" className="size-3.5" />
                      Star
                    </Button>
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
        <p className="mt-7 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Icon name="people" className="size-3.5" />
          Better ideas happen together.
        </p>
      </section>
    </main>
  );
}
