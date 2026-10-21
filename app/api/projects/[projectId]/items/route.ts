import {
  createItemSchema,
  emptyInputSchema,
  itemResponseSchema,
  itemsResponseSchema,
  projectParamsSchema,
} from "@/lib/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { createItem, listItems } from "@/lib/items";
import { requireRole } from "@/lib/permissions";
import { emitToProject } from "@/lib/realtime-bus";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    return jsonResponse(itemsResponseSchema, {
      items: await listItems(projectId, request.headers),
    });
  });
}

export function POST(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    await requireRole(projectId, "EDITOR", request.headers);
    const input = await readJson(request, createItemSchema);
    const item = await createItem(projectId, input);
    emitToProject(projectId, "tree:changed", {
      projectId,
      changedAt: new Date().toISOString(),
    });
    return jsonResponse(itemResponseSchema, { item }, 201);
  });
}
