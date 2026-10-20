import {
  emptyInputSchema,
  runInputSchema,
  runResponseSchema,
} from "@collab/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { executeRun } from "@/lib/runs";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: Request) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const input = await readJson(request, runInputSchema, 512 * 1024);
    return jsonResponse(
      runResponseSchema,
      await executeRun(input, request.headers),
      201,
    );
  });
}
