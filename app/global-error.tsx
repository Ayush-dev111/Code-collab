"use client";

export default function GlobalError({ reset }: { reset: () => void }) {
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
