import {
  imageUploadFormSchema,
  imageUploadHeadersSchema,
  imageUploadInputSchema,
  MAX_IMAGE_BYTES,
} from "@/lib/shared";
import { ApiError, parseInput } from "@/lib/api";

const maximumRequestBytes = MAX_IMAGE_BYTES + 65536;
export async function readImageUpload(
  request: Request,
): Promise<{ bytes: Uint8Array; contentType: string; extension: string }> {
  const contentLength = request.headers.get("content-length");
  const headers = parseInput(imageUploadHeadersSchema, {
    contentType: request.headers.get("content-type"),
    ...(contentLength === null ? {} : { contentLength }),
  });
  if (!request.body)
    throw new ApiError(400, "INVALID_IMAGE", "Choose an image to upload.");
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumRequestBytes) {
        await reader.cancel();
        throw new ApiError(
          413,
          "IMAGE_TOO_LARGE",
          "Images must be at most 5 MiB.",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let form: FormData;
  try {
    form = await new Response(body.buffer, {
      headers: { "content-type": headers.contentType },
    }).formData();
  } catch {
    throw new ApiError(400, "INVALID_IMAGE", "Send a valid image upload.");
  }
  if ([...form.keys()].length !== 1 || !form.has("file"))
    throw new ApiError(400, "INVALID_IMAGE", "Send exactly one image file.");
  const { file } = parseInput(imageUploadFormSchema, {
    file: form.get("file"),
  });
  parseInput(imageUploadInputSchema, {
    name: file.name,
    type: file.type,
    size: file.size,
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extension = verifiedImageExtension(bytes, file.type);
  return { bytes, contentType: file.type, extension };
}
function verifiedImageExtension(bytes: Uint8Array, type: string): string {
  const prefix = Buffer.from(bytes.subarray(0, 16));
  if (
    type === "image/png" &&
    prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (
    type === "image/jpeg" &&
    prefix[0] === 255 &&
    prefix[1] === 216 &&
    prefix[2] === 255
  )
    return "jpg";
  if (
    type === "image/gif" &&
    ["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString("ascii"))
  )
    return "gif";
  if (
    type === "image/webp" &&
    prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
    prefix.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  throw new ApiError(
    400,
    "INVALID_IMAGE",
    "The image contents do not match its file type.",
  );
}
