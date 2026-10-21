import {
  itemParamsSchema,
  runHistoryQuerySchema,
  runHistoryResponseSchema,
} from "@/lib/shared";
import { jsonResponse, parseInput, parseQuery, withApiError } from "@/lib/api";
import { getRunHistory } from "@/lib/runs";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string; itemId: string }> };

export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    const { projectId, itemId } = parseInput(
      itemParamsSchema,
      await context.params,
    );
    const query = parseQuery(request, runHistoryQuerySchema);
    return jsonResponse(
      runHistoryResponseSchema,
      await getRunHistory(projectId, itemId, query.before, request.headers),
    );
  });
}
