import { randomUUID } from "node:crypto";
import {
  emptyInputSchema,
  imageUploadResponseSchema,
  itemParamsSchema,
} from "@collab/shared";
import {
  ApiError,
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  withApiError,
} from "@/lib/api";
import { requireRole } from "@/lib/permissions";
import { getItem } from "@/lib/items";
import { readImageUpload } from "@/lib/image-upload";
import { requireImageStorage, storeImage } from "@/lib/storage";

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
    const item = await getItem(projectId, itemId, request.headers);
    if (item.type !== "PAGE")
      throw new ApiError(400, "INVALID_ITEM", "Upload images to a page.");
    const { bytes, contentType, extension } = await readImageUpload(request);
    requireImageStorage();
    const imageKey = `${randomUUID()}.${extension}`;
    await storeImage(
      `projects/${projectId}/items/${itemId}/${imageKey}`,
      bytes,
      contentType,
    );
    return jsonResponse(
      imageUploadResponseSchema,
      { url: `/api/projects/${projectId}/items/${itemId}/images/${imageKey}` },
      201,
    );
  });
}
