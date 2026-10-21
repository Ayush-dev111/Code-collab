export default function ProjectsLoading() {
  return (
    <main role="status" className="mx-auto max-w-6xl px-6 py-14">
      <div className="h-8 w-56 animate-pulse rounded bg-border" />
      <p className="mt-5 text-sm text-muted-foreground">
        Loading your projects…
      </p>
    </main>
  );
}
