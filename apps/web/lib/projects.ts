import { getDatabase } from "@collab/db";
import { type ProjectDetails, type ProjectSummary } from "@collab/shared";
import { ApiError } from "@/lib/api";
import { requireRole, requireSession } from "@/lib/permissions";

export async function listUserProjects(
  requestHeaders?: Headers,
): Promise<ProjectSummary[]> {
  const session = await requireSession(requestHeaders);
  const memberships = await getDatabase().projectMember.findMany({
    where: { userId: session.user.id },
    include: { project: true },
    orderBy: [{ project: { createdAt: "desc" } }, { projectId: "asc" }],
  });
  return memberships.map(({ role, project }) => ({
    id: project.id,
    name: project.name,
    role,
    createdAt: project.createdAt.toISOString(),
  }));
}

export async function getProjectDetails(
  projectId: string,
  requestHeaders?: Headers,
): Promise<ProjectDetails> {
  const { membership } = await requireRole(projectId, "VIEWER", requestHeaders);
  const project = await getDatabase().project.findUnique({
    where: { id: projectId },
    include: {
      members: { include: { user: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!project)
    throw new ApiError(
      404,
      "PROJECT_NOT_FOUND",
      "This project no longer exists.",
    );
  return {
    id: project.id,
    name: project.name,
    role: membership.role,
    createdAt: project.createdAt.toISOString(),
    members: project.members.map(({ role, user }) => ({
      id: user.id,
      name: user.name,
      image: user.image,
      role,
    })),
  };
}
