import {
  storageEnvironmentSchema,
  storageObjectKeySchema,
} from "@collab/shared";
import { ApiError, parseInput } from "@/lib/api";
import { signS3Request } from "@/lib/s3-signing";

export function requireImageStorage() {
  const parsed = storageEnvironmentSchema.safeParse(process.env);
  if (!parsed.success)
    throw new ApiError(
      503,
      "STORAGE_UNAVAILABLE",
      "Image storage is not configured. Ask the project administrator to configure it.",
    );
  const configuration = parsed.data;
  const endpoint = new URL(
    configuration.S3_ENDPOINT ??
      `https://s3.${configuration.S3_REGION}.amazonaws.com`,
  );
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/"
  ) {
    throw new ApiError(
      503,
      "STORAGE_UNAVAILABLE",
      "The image storage endpoint must be an origin without a path or query.",
    );
  }
  return { ...configuration, endpoint };
}

async function objectRequest(
  method: "GET" | "PUT",
  key: string,
  body?: Uint8Array,
  contentType?: string,
): Promise<Response> {
  const configuration = requireImageStorage();
  const objectKey = parseInput(storageObjectKeySchema, key);
  const url = new URL(configuration.endpoint);
  if (configuration.S3_FORCE_PATH_STYLE === "true")
    url.pathname = `/${configuration.S3_BUCKET}/${objectKey}`;
  else {
    url.hostname = `${configuration.S3_BUCKET}.${url.hostname}`;
    url.pathname = `/${objectKey}`;
  }
  const headers = signS3Request({
    method,
    url,
    region: configuration.S3_REGION,
    accessKeyId: configuration.S3_ACCESS_KEY_ID,
    secretAccessKey: configuration.S3_SECRET_ACCESS_KEY,
    ...(configuration.S3_SESSION_TOKEN
      ? { sessionToken: configuration.S3_SESSION_TOKEN }
      : {}),
    ...(body ? { body } : {}),
    ...(contentType ? { contentType } : {}),
  });
  try {
    const response = await fetch(url, {
      method,
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      ...(body ? { body: new Uint8Array(body).buffer } : {}),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new ApiError(404, "IMAGE_NOT_FOUND", "This image is unavailable.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        502,
        "STORAGE_ERROR",
        "Image storage could not complete the request. Try again.",
      );
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      502,
      "STORAGE_ERROR",
      "Image storage could not be reached. Try again.",
    );
  }
}
export async function storeImage(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  const response = await objectRequest("PUT", key, body, contentType);
  await response.body?.cancel();
}
export function readImage(key: string): Promise<Response> {
  return objectRequest("GET", key);
}
