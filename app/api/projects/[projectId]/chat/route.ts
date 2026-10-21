import {
  chatHistoryQuerySchema,
  chatHistoryResponseSchema,
  projectParamsSchema,
} from "@/lib/shared";
import { jsonResponse, parseInput, parseQuery, withApiError } from "@/lib/api";
import { getChatHistory } from "@/lib/chat";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };
export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    const { before } = parseQuery(request, chatHistoryQuerySchema);
    return jsonResponse(
      chatHistoryResponseSchema,
      await getChatHistory(projectId, before, request.headers),
    );
  });
}
