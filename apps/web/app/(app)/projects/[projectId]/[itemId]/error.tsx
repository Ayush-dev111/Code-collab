"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function PageError({ reset }: { reset: () => void }) {
  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <h1 className="text-2xl font-semibold">The page could not be opened</h1>
      <p role="alert" className="mt-3 text-sm leading-6 text-muted-foreground">
        Check your connection and try again.
      </p>
      <div className="mt-6 flex items-center gap-4">
        <Button onClick={reset}>Try again</Button>
        <Link href="/projects" className="text-sm text-primary">
          Back to projects
        </Link>
      </div>
    </main>
  );
}
