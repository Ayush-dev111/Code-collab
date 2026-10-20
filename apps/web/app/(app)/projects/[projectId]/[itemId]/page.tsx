import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  itemPageParamsSchema,
  realtimeUserSchema,
  userColor,
} from "@collab/shared";
import { RoomShell } from "@/components/workspace/room-shell";
import { getProjectDetails } from "@/lib/projects";
import { getItem } from "@/lib/items";
import { requireSession } from "@/lib/permissions";
import { ApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ItemPage({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}) {
  const parsed = itemPageParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  const { projectId, itemId } = parsed.data;
  let project;
  let item;
  let currentUser;
  try {
    project = await getProjectDetails(projectId);
    item = await getItem(projectId, itemId);
    if (item.type === "FOLDER") redirect(`/projects/${projectId}`);
    const { user } = await requireSession();
    currentUser = realtimeUserSchema.parse({
      id: user.id,
      name: user.name,
      image: user.image ?? null,
      color: userColor(user.id),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect(
        `/login?callbackURL=${encodeURIComponent(`/projects/${projectId}/${itemId}`)}`,
      );
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && [403, 409].includes(error.status))
      return (
        <main className="mx-auto max-w-lg px-6 py-20">
          <h1 className="text-2xl font-semibold">This page is unavailable</h1>
          <p
            role="alert"
            className="mt-3 text-sm leading-6 text-muted-foreground"
          >
            {error.message}
          </p>
          <Link
            href="/projects"
            className="mt-6 inline-block text-sm font-medium text-primary"
          >
            Back to your projects
          </Link>
        </main>
      );
    throw error;
  }
  return (
    <RoomShell
      initialProject={project}
      initialItem={item}
      currentUser={currentUser}
    />
  );
}
