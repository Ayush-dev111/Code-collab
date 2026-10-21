"use client";

import dynamic from "next/dynamic";

export const CodeEditor = dynamic(() => import("./code-document"), {
  ssr: false,
  loading: () => (
    <section
      role="status"
      className="min-w-0 bg-card px-6 py-10 text-sm text-muted-foreground"
    >
      Loading code editor...
    </section>
  ),
});
