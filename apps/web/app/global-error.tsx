"use client";
import { useEffect } from "react";
import { captureException } from "@sentry/nextjs";
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error);
  }, [error]);
  return (
    <html lang="en">
      <body>
        <main style={{ padding: "3rem", fontFamily: "system-ui" }}>
          <h1>Something went wrong</h1>
          <p>The workspace could not load. Please try again.</p>
          <button onClick={reset}>Try again</button>
        </main>
      </body>
    </html>
  );
}
