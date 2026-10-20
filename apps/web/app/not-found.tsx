import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-lg px-6 py-20">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link className="mt-6 inline-block text-primary underline" href="/">
        Return to the workspace
      </Link>
    </main>
  );
}
