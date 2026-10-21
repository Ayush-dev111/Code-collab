import { emptyInputSchema, imageParamsSchema } from "@/lib/shared";
import { parseInput, parseQuery, withApiError } from "@/lib/api";
import { requireRole } from "@/lib/permissions";
import { loadImage } from "@/lib/images";

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
    await requireRole(projectId, "VIEWER", request.headers);
    const image = await loadImage(projectId, itemId, imageKey);
    return new Response(Buffer.from(image.data), {
      headers: {
        "Content-Type": image.contentType,
        "Content-Length": String(image.data.byteLength),
        // Keys are random and never reused, so the browser may keep a copy.
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": `inline; filename="${imageKey}"`,
      },
    });
  });
}
