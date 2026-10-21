import Link from "next/link";
import { redirect } from "next/navigation";
import { inviteParamsSchema } from "@/lib/shared";
import { InviteJoin } from "@/components/projects/invite-join";
import { ApiError } from "@/lib/api";
import { requireSession } from "@/lib/permissions";
import { AppHeader } from "@/components/workspace/app-header";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const parsed = inviteParamsSchema.safeParse(await params);
  if (!parsed.success)
    return (
      <main className="mx-auto max-w-md px-6 py-20">
        <h1 className="text-2xl font-semibold">Invalid invitation</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          This invitation link is incomplete. Ask the owner for a new link.
        </p>
        <Link
          href="/projects"
          className="mt-6 inline-block text-sm font-medium text-primary"
        >
          Go to your projects →
        </Link>
      </main>
    );
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect(
        `/login?callbackURL=${encodeURIComponent(`/invite/${parsed.data.code}`)}`,
      );
    throw error;
  }
  return (
    <div className="min-h-dvh">
      <AppHeader name={session.user.name} />
      <InviteJoin code={parsed.data.code} />
    </div>
  );
}
