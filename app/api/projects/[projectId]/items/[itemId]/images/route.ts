import { randomUUID } from "node:crypto";
import {
  emptyInputSchema,
  imageUploadResponseSchema,
  itemParamsSchema,
} from "@/lib/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  withApiError,
} from "@/lib/api";
import { requireRole } from "@/lib/permissions";
import { readImageUpload } from "@/lib/image-upload";
import { saveImage } from "@/lib/images";

export const runtime = "nodejs";
export function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; itemId: string }> },
) {
  return withApiError(async () => {
    const { projectId, itemId } = parseInput(
      itemParamsSchema,
      await context.params,
    );
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    await requireRole(projectId, "EDITOR", request.headers);
    const { bytes, contentType, extension } = await readImageUpload(request);
    const imageKey = `${randomUUID()}.${extension}`;
    await saveImage(projectId, itemId, imageKey, contentType, bytes);
    return jsonResponse(
      imageUploadResponseSchema,
      { url: `/api/projects/${projectId}/items/${itemId}/images/${imageKey}` },
      201,
    );
  });
}
