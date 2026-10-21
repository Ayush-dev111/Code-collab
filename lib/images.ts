import { getDatabase } from "@/lib/db";
import { ApiError } from "@/lib/api";

// Page images are stored in PostgreSQL. The image id is its public file name.
export async function saveImage(
  projectId: string,
  itemId: string,
  imageKey: string,
  contentType: string,
  bytes: Uint8Array,
) {
  const page = await getDatabase().item.findFirst({
    where: { id: itemId, projectId, type: "PAGE" },
    select: { id: true },
  });
  if (!page)
    throw new ApiError(400, "INVALID_ITEM", "Upload images to a page.");
  await getDatabase().image.create({
    data: { id: imageKey, itemId, contentType, data: new Uint8Array(bytes) },
  });
}

export async function loadImage(
  projectId: string,
  itemId: string,
  imageKey: string,
) {
  const image = await getDatabase().image.findFirst({
    where: { id: imageKey, itemId, item: { projectId, type: "PAGE" } },
    select: { contentType: true, data: true },
  });
  if (!image)
    throw new ApiError(404, "IMAGE_NOT_FOUND", "This image is unavailable.");
  return image;
}
