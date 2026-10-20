import type { TreeItem as ProjectItem } from "@collab/shared";
import type { QueryClient } from "@tanstack/react-query";

export function childrenOf(items: ProjectItem[], parentId: string | null) {
  return items
    .filter((item) => item.parentId === parentId)
    .sort(
      (left, right) =>
        left.order - right.order || left.id.localeCompare(right.id),
    );
}

export function descendantsOf(items: ProjectItem[], itemId: string) {
  const descendants = new Set<string>([itemId]);
  let previousSize = 0;
  while (descendants.size !== previousSize) {
    previousSize = descendants.size;
    for (const item of items) {
      if (item.parentId && descendants.has(item.parentId))
        descendants.add(item.id);
    }
  }
  return descendants;
}

export const itemsQueryKey = (projectId: string) =>
  ["items", projectId] as const;
export const notificationQueryKey = (projectId: string) =>
  ["tree-notification", projectId] as const;
export function recordTreeNotification(
  client: QueryClient,
  projectId: string,
  pending = false,
) {
  client.setQueryData(notificationQueryKey(projectId), pending);
}
