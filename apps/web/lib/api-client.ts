"use client";

import { useSyncExternalStore } from "react";
import { apiErrorSchema } from "@collab/shared";

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export async function apiRequest<T>(
  path: string,
  schema: { parse: (input: unknown) => T },
  options?: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
  },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: options?.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      ...(options?.body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.body),
          }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiClientError(
      "Unable to connect. Check your connection and try again.",
      0,
      "NETWORK_ERROR",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(body);
    throw new ApiClientError(
      parsed.success
        ? parsed.data.message
        : "The request failed. Please try again.",
      response.status,
      parsed.success ? parsed.data.code : "REQUEST_FAILED",
    );
  }
  try {
    return schema.parse(body);
  } catch {
    throw new ApiClientError(
      "The server returned an unexpected response. Please try again.",
      response.status,
      "INVALID_RESPONSE",
    );
  }
}

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnline() {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

export function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}
