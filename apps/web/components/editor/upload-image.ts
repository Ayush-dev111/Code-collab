import {
  apiErrorSchema,
  imageUploadInputSchema,
  imageUploadResponseSchema,
} from "@collab/shared";
import { ApiClientError } from "@/lib/api-client";

export async function uploadPageImage(
  projectId: string,
  itemId: string,
  file: File,
) {
  const parsed = imageUploadInputSchema.safeParse({
    name: file.name,
    type: file.type,
    size: file.size,
  });
  if (!parsed.success)
    throw new Error("Choose a PNG, JPEG, GIF or WebP image up to 8 MiB.");
  const body = new FormData();
  body.append("file", file);
  let response: Response;
  try {
    response = await fetch(
      `/api/projects/${projectId}/items/${itemId}/images`,
      { method: "POST", credentials: "same-origin", body },
    );
  } catch {
    throw new Error(
      "Image upload failed. Check your connection and try again.",
    );
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiErrorSchema.safeParse(result);
    throw new ApiClientError(
      error.success
        ? error.data.message
        : "The image could not be uploaded. Please try again.",
      response.status,
      error.success ? error.data.code : "UPLOAD_FAILED",
    );
  }
  return imageUploadResponseSchema.parse(result).url;
}
