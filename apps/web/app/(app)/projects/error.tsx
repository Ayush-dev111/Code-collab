"use client";

import { Button } from "@/components/ui/button";

export default function ProjectsError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <h1 className="text-2xl font-semibold">Unable to open your workspace</h1>
      <p className="mt-3 text-sm leading-6 text-muted-foreground">
        Check your connection and try again.
      </p>
      <Button className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
