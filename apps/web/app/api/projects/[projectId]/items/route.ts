import {
  createItemSchema,
  emptyInputSchema,
  itemResponseSchema,
  itemsResponseSchema,
  projectParamsSchema,
} from "@collab/shared";
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
import { notifyTreeChanged } from "@/lib/tree-notifications";

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
    const { session } = await requireRole(projectId, "EDITOR", request.headers);
    const input = await readJson(request, createItemSchema);
    const actor = { userId: session.user.id, sessionId: session.session.id };
    const item = await createItem(projectId, input, actor);
    const notification = await notifyTreeChanged({ projectId, ...actor });
    return jsonResponse(
      itemResponseSchema,
      { item, notificationPending: !notification },
      201,
    );
  });
}
