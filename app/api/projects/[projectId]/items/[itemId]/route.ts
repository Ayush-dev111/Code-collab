import {
  deleteItemsResponseSchema,
  emptyInputSchema,
  itemParamsSchema,
  itemResponseSchema,
  updateItemSchema,
} from "@/lib/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { deleteItem, getItem, updateItem } from "@/lib/items";
import { requireRole } from "@/lib/permissions";
import { emitToProject } from "@/lib/realtime-bus";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string; itemId: string }> };

function treeChanged(projectId: string) {
  emitToProject(projectId, "tree:changed", {
    projectId,
    changedAt: new Date().toISOString(),
  });
}

export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    const { projectId, itemId } = parseInput(
      itemParamsSchema,
      await context.params,
    );
    return jsonResponse(itemResponseSchema, {
      item: await getItem(projectId, itemId, request.headers),
    });
  });
}

export function PATCH(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { projectId, itemId } = parseInput(
      itemParamsSchema,
      await context.params,
    );
    await requireRole(projectId, "EDITOR", request.headers);
    const input = await readJson(request, updateItemSchema);
    const item = await updateItem(projectId, itemId, input);
    treeChanged(projectId);
    return jsonResponse(itemResponseSchema, { item });
  });
}

export function DELETE(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { projectId, itemId } = parseInput(
      itemParamsSchema,
      await context.params,
    );
    await requireRole(projectId, "EDITOR", request.headers);
    await readJson(request, emptyInputSchema);
    const deletedIds = await deleteItem(projectId, itemId);
    treeChanged(projectId);
    return jsonResponse(deleteItemsResponseSchema, { deletedIds });
  });
}
