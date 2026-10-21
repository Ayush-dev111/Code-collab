export default function LoadingPage() {
  return (
    <section
      role="status"
      className="min-h-full animate-pulse space-y-5 rounded-md border border-border bg-card p-6"
    >
      <p className="text-sm text-muted-foreground">Opening shared page...</p>
      <div className="h-8 w-1/3 rounded bg-border" />
      <div className="h-60 rounded-xl bg-secondary" />
    </section>
  );
}
