import { getDatabase } from "@collab/db";
import {
  createProjectSchema,
  createdProjectResponseSchema,
  emptyInputSchema,
  projectsResponseSchema,
} from "@collab/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { requireSession } from "@/lib/permissions";
import { listUserProjects } from "@/lib/projects";

export const runtime = "nodejs";

export function GET(request: Request) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    return jsonResponse(projectsResponseSchema, {
      projects: await listUserProjects(request.headers),
    });
  });
}

export function POST(request: Request) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const session = await requireSession(request.headers);
    const input = await readJson(request, createProjectSchema);
    // The project and its owner membership are created in one nested-write transaction.
    const project = await getDatabase().project.create({
      data: {
        name: input.name,
        ownerId: session.user.id,
        members: { create: { userId: session.user.id, role: "OWNER" } },
      },
    });
    return jsonResponse(
      createdProjectResponseSchema,
      {
        project: {
          id: project.id,
          name: project.name,
          role: "OWNER",
          createdAt: project.createdAt.toISOString(),
        },
      },
      201,
    );
  });
}
