import { notFound, redirect } from "next/navigation";
import { itemPageParamsSchema } from "@/lib/shared";
import { ItemWorkspace } from "@/components/workspace/item-workspace";
import { getItem } from "@/lib/items";
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
  let item;
  try {
    item = await getItem(projectId, itemId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401)
      redirect(
        `/login?callbackURL=${encodeURIComponent(`/projects/${projectId}/${itemId}`)}`,
      );
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403)
      return (
        <section className="rounded-md border border-border bg-card p-8">
          <h2 className="text-lg font-semibold">This page is unavailable</h2>
          <p role="alert" className="mt-2 text-sm text-muted-foreground">
            {error.message}
          </p>
        </section>
      );
    throw error;
  }
  if (item.type === "FOLDER") redirect(`/projects/${projectId}`);
  return <ItemWorkspace item={item} />;
}
