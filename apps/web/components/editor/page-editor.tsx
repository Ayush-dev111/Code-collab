"use client";

import dynamic from "next/dynamic";

export const PageEditor = dynamic(() => import("./page-document"), {
  ssr: false,
  loading: () => (
    <section
      role="status"
      className="min-w-0 bg-card px-6 py-10 text-sm text-muted-foreground"
    >
      Loading page editor...
    </section>
  ),
});
