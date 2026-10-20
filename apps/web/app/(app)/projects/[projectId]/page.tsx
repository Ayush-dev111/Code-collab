import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { projectParamsSchema } from "@collab/shared";
import { RoomShell } from "@/components/workspace/room-shell";
import { getProjectDetails } from "@/lib/projects";
import { ApiError } from "@/lib/api";
import { requireSession } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const parsed = projectParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  let project;
  let currentUserId;
  try {
    project = await getProjectDetails(parsed.data.projectId);
    currentUserId = (await requireSession()).user.id;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect(
        `/login?callbackURL=${encodeURIComponent(`/projects/${parsed.data.projectId}`)}`,
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
  return <RoomShell initialProject={project} currentUserId={currentUserId} />;
}
