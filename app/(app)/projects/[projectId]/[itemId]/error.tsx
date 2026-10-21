"use client";

import { Button } from "@/components/ui/button";

export default function PageError({ reset }: { reset: () => void }) {
  return (
    <section className="rounded-md border border-border bg-card p-8">
      <h2 className="text-lg font-semibold">The page could not be opened</h2>
      <p role="alert" className="mt-2 text-sm leading-6 text-muted-foreground">
        Check your connection and try again.
      </p>
      <Button className="mt-5" onClick={reset}>
        Try again
      </Button>
    </section>
  );
}
