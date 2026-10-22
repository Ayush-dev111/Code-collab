import { notFound } from "next/navigation";
import { itemPageParamsSchema } from "@/lib/shared";
import { ItemWorkspace } from "@/components/workspace/item-workspace";

// The project layout has already checked access, and the item comes from the
// sidebar's list in the browser, so opening a page needs no database query.
export default async function ItemPage({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}) {
  const parsed = itemPageParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();
  return <ItemWorkspace itemId={parsed.data.itemId} />;
}
