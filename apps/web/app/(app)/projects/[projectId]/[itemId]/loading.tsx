export default function LoadingPage() {
  return (
    <main
      role="status"
      className="mx-auto max-w-5xl animate-pulse space-y-5 px-6 py-12"
    >
      <p className="text-sm text-muted-foreground">Opening shared page...</p>
      <div className="h-8 w-1/3 rounded bg-border" />
      <div className="h-60 rounded-xl bg-secondary" />
    </main>
  );
}
