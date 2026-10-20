import {
  deleteItemsResponseSchema,
  emptyInputSchema,
  itemParamsSchema,
  itemResponseSchema,
  updateItemSchema,
} from "@collab/shared";
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
import { notifyTreeChanged } from "@/lib/tree-notifications";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string; itemId: string }> };

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
    const { session } = await requireRole(projectId, "EDITOR", request.headers);
    const input = await readJson(request, updateItemSchema);
    const actor = { userId: session.user.id, sessionId: session.session.id };
    const item = await updateItem(projectId, itemId, input, actor);
    const notification = await notifyTreeChanged({ projectId, ...actor });
    return jsonResponse(itemResponseSchema, {
      item,
      notificationPending: !notification,
    });
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
    const { session } = await requireRole(projectId, "EDITOR", request.headers);
    await readJson(request, emptyInputSchema);
    const actor = { userId: session.user.id, sessionId: session.session.id };
    const deletedIds = await deleteItem(projectId, itemId, actor);
    const notification = await notifyTreeChanged({ projectId, ...actor });
    return jsonResponse(deleteItemsResponseSchema, {
      deletedIds,
      notificationPending: !notification,
    });
  });
}
