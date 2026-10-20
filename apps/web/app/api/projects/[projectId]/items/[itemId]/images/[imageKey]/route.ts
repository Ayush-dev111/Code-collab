import {
  emptyInputSchema,
  imageParamsSchema,
  imageStorageHeadersSchema,
} from "@collab/shared";
import { ApiError, parseInput, parseQuery, withApiError } from "@/lib/api";
import { getItem } from "@/lib/items";
import { readImage } from "@/lib/storage";

export const runtime = "nodejs";
export function GET(
  request: Request,
  context: {
    params: Promise<{ projectId: string; itemId: string; imageKey: string }>;
  },
) {
  return withApiError(async () => {
    const { projectId, itemId, imageKey } = parseInput(
      imageParamsSchema,
      await context.params,
    );
    parseQuery(request, emptyInputSchema);
    const item = await getItem(projectId, itemId, request.headers);
    if (item.type !== "PAGE")
      throw new ApiError(404, "IMAGE_NOT_FOUND", "This image is unavailable.");
    const response = await readImage(
      `projects/${projectId}/items/${itemId}/${imageKey}`,
    );
    const metadata = imageStorageHeadersSchema.safeParse({
      contentLength: response.headers.get("content-length"),
    });
    if (!response.body || !metadata.success) {
      await response.body?.cancel();
      throw new ApiError(
        502,
        "STORAGE_ERROR",
        "Image storage returned an invalid image.",
      );
    }
    const length = metadata.data.contentLength;
    let receivedBytes = 0;
    const boundedBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > length)
            throw new Error("Image storage exceeded its declared length.");
          controller.enqueue(chunk);
        },
        flush() {
          if (receivedBytes !== length)
            throw new Error("Image storage returned an incomplete image.");
        },
      }),
    );
    const extension = imageKey.split(".").at(-1);
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    };
    return new Response(boundedBody, {
      headers: {
        "Content-Type": types[extension ?? ""] ?? "application/octet-stream",
        "Content-Length": String(length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `inline; filename="${imageKey}"`,
      },
    });
  });
}
