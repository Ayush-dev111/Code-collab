import { getDatabase } from "@/lib/db";
import {
  emptyInputSchema,
  projectParamsSchema,
  projectResponseSchema,
  updateProjectSchema,
} from "@/lib/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { requireRole } from "@/lib/permissions";
import { getProjectDetails } from "@/lib/projects";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    return jsonResponse(projectResponseSchema, {
      project: await getProjectDetails(projectId, request.headers),
    });
  });
}

export function PATCH(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    await requireRole(projectId, "EDITOR", request.headers);
    const input = await readJson(request, updateProjectSchema);
    await getDatabase().project.update({
      where: { id: projectId },
      data: { name: input.name },
    });
    return jsonResponse(projectResponseSchema, {
      project: await getProjectDetails(projectId, request.headers),
    });
  });
}
