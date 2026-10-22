import Link from "next/link";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import { projectParamsSchema, realtimeUser } from "@/lib/shared";
import { RoomShell } from "@/components/workspace/room-shell";
import { getProjectDetails } from "@/lib/projects";
import { listItems } from "@/lib/items";
import { ApiError } from "@/lib/api";
import { requireSession } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The project shell (sidebar, chat, live connection) renders once here and
// stays mounted while people open different pages and files.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const parsed = projectParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { projectId } = parsed.data;
  let project;
  let session;
  let items;
  try {
    // One round trip: the item list loads alongside the project, so a page
    // opened directly does not wait for the sidebar to fetch it.
    [project, session, items] = await Promise.all([
      getProjectDetails(projectId),
      requireSession(),
      listItems(projectId),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect(
        `/login?callbackURL=${encodeURIComponent(`/projects/${projectId}`)}`,
      );
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403)
      return (
        <main className="mx-auto max-w-lg px-6 py-20">
          <h1 className="text-2xl font-semibold">
            You do not have access to this project
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Ask the project owner for an invitation to join.
          </p>
          <Link
            href="/projects"
            className="mt-6 inline-block text-sm font-medium text-primary"
          >
            ← Back to your projects
          </Link>
        </main>
      );
    throw error;
  }
  return (
    <RoomShell
      initialProject={project}
      initialItems={items}
      currentUser={realtimeUser(session.user)}
    >
      {children}
    </RoomShell>
  );
}
