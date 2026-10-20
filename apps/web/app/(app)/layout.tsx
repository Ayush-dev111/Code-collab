import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { requireSession } from "@/lib/permissions";
import { ApiError } from "@/lib/api";
import { AppHeader } from "@/components/workspace/app-header";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: ReactNode;
}) {
  let session;
  try {
    session = await requireSession();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect("/login?callbackURL=%2Fprojects");
    throw error;
  }
  return (
    <div className="min-h-dvh">
      <AppHeader name={session.user.name} />
      {children}
    </div>
  );
}
