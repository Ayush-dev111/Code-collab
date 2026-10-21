import { getDatabase } from "@/lib/db";
import {
  itemParamsSchema,
  treeItemSchema,
  type CreateItemInput,
  type TreeItem,
  type UpdateItemInput,
} from "@/lib/shared";
import { ApiError, parseInput } from "@/lib/api";
import { requireRole } from "@/lib/permissions";

type Database = ReturnType<typeof getDatabase>;
type Transaction = Parameters<Parameters<Database["$transaction"]>[0]>[0];

const itemSelect = {
  id: true,
  projectId: true,
  parentId: true,
  type: true,
  title: true,
  language: true,
  order: true,
  createdAt: true,
  updatedAt: true,
} as const;

type StoredItem = {
  id: string;
  projectId: string;
  parentId: string | null;
  type: "PAGE" | "FOLDER" | "CODE";
  title: string;
  language: string | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
};

function toTreeItem(item: StoredItem): TreeItem {
  return treeItemSchema.parse({
    ...item,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  });
}

export async function listItems(
  projectId: string,
  requestHeaders?: Headers,
): Promise<TreeItem[]> {
  const [, items] = await Promise.all([
    requireRole(projectId, "VIEWER", requestHeaders),
    getDatabase().item.findMany({
      where: { projectId },
      select: itemSelect,
      orderBy: [{ parentId: "asc" }, { order: "asc" }, { id: "asc" }],
    }),
  ]);
  return items.map(toTreeItem);
}

export async function getItem(
  projectId: string,
  itemId: string,
  requestHeaders?: Headers,
): Promise<TreeItem> {
  const input = parseInput(itemParamsSchema, { projectId, itemId });
  // The permission check and the read run together; nothing is returned
  // unless the check passes.
  const [, item] = await Promise.all([
    requireRole(input.projectId, "VIEWER", requestHeaders),
    getDatabase().item.findFirst({
      where: { id: input.itemId, projectId: input.projectId },
      select: itemSelect,
    }),
  ]);
  if (!item) throw itemNotFound();
  return toTreeItem(item);
}

function itemNotFound(): ApiError {
  return new ApiError(404, "ITEM_NOT_FOUND", "This item no longer exists.");
}

// Callers check EDITOR access with requireRole before mutating the tree.
async function mutateTree<T>(
  projectId: string,
  mutation: (transaction: Transaction, items: StoredItem[]) => Promise<T>,
): Promise<T> {
  return getDatabase().$transaction(
    async (transaction) => {
      // Every tree write takes the same project lock before reading siblings.
      // The lock prevents concurrent moves, creates, and deletes from using
      // stale orders or introducing a cycle across separate requests.
      const project = await transaction.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "project" WHERE "id" = ${projectId} FOR UPDATE
      `;
      if (project.length === 0) {
        throw new ApiError(
          404,
          "PROJECT_NOT_FOUND",
          "This project no longer exists.",
        );
      }
      const items = await transaction.item.findMany({
        where: { projectId },
        select: itemSelect,
        orderBy: [{ order: "asc" }, { id: "asc" }],
      });
      return mutation(transaction, items);
    },
    { maxWait: 10_000, timeout: 15_000 },
  );
}

function requireItem(items: StoredItem[], itemId: string): StoredItem {
  const item = items.find((candidate) => candidate.id === itemId);
  if (!item) throw itemNotFound();
  return item;
}

function assertFolderParent(
  items: StoredItem[],
  parentId: string | null,
): void {
  if (parentId === null) return;
  const parent = items.find((item) => item.id === parentId);
  if (!parent || parent.type !== "FOLDER") {
    throw new ApiError(
      400,
      "INVALID_PARENT",
      "Choose a folder in this project as the parent.",
    );
  }
}

function siblingsOf(items: StoredItem[], parentId: string | null) {
  return items.filter((item) => item.parentId === parentId);
}

async function normalizeSiblings(
  transaction: Transaction,
  items: StoredItem[],
  parentId: string | null,
): Promise<void> {
  for (const [order, item] of items.entries()) {
    if (item.order === order && item.parentId === parentId) continue;
    await transaction.item.update({
      where: { id: item.id },
      data: { parentId, order },
    });
  }
}

export async function createItem(
  projectId: string,
  input: CreateItemInput,
): Promise<TreeItem> {
  return mutateTree(projectId, async (transaction, items) => {
    assertFolderParent(items, input.parentId);
    const siblings = siblingsOf(items, input.parentId);
    await normalizeSiblings(transaction, siblings, input.parentId);
    const item = await transaction.item.create({
      data: {
        projectId,
        ...input,
        order: siblings.length,
        language:
          input.type === "CODE" ? (input.language ?? "javascript") : null,
      },
      select: itemSelect,
    });
    return toTreeItem(item);
  });
}

function assertNoCycle(
  items: StoredItem[],
  itemId: string,
  parentId: string | null,
): void {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visited = new Set<string>();
  let ancestor = parentId;
  while (ancestor !== null) {
    if (ancestor === itemId || visited.has(ancestor)) {
      throw new ApiError(
        400,
        "INVALID_MOVE",
        "A folder cannot be moved into itself or one of its descendants.",
      );
    }
    visited.add(ancestor);
    ancestor = byId.get(ancestor)?.parentId ?? null;
  }
}

export async function updateItem(
  projectId: string,
  itemId: string,
  input: UpdateItemInput,
): Promise<TreeItem> {
  return mutateTree(projectId, async (transaction, items) => {
    const item = requireItem(items, itemId);
    if (input.action === "language") {
      if (item.type !== "CODE")
        throw new ApiError(
          400,
          "INVALID_ITEM_TYPE",
          "Only code files have a language.",
        );
      return toTreeItem(
        await transaction.item.update({
          where: { id: item.id },
          data: { language: input.language },
          select: itemSelect,
        }),
      );
    }
    if (input.action === "rename") {
      const updated = await transaction.item.update({
        where: { id: item.id },
        data: { title: input.title },
        select: itemSelect,
      });
      return toTreeItem(updated);
    }
    assertFolderParent(items, input.parentId);
    assertNoCycle(items, item.id, input.parentId);
    const destination = siblingsOf(items, input.parentId).filter(
      (sibling) => sibling.id !== item.id,
    );
    if (input.index > destination.length) {
      throw new ApiError(
        400,
        "INVALID_POSITION",
        "The requested position is outside the destination folder.",
      );
    }
    destination.splice(input.index, 0, item);
    await normalizeSiblings(transaction, destination, input.parentId);
    if (item.parentId !== input.parentId) {
      const source = siblingsOf(items, item.parentId).filter(
        (sibling) => sibling.id !== item.id,
      );
      await normalizeSiblings(transaction, source, item.parentId);
    }
    const updated = await transaction.item.findUnique({
      where: { id: item.id },
      select: itemSelect,
    });
    if (!updated) throw itemNotFound();
    return toTreeItem(updated);
  });
}

function collectSubtree(items: StoredItem[], rootId: string): StoredItem[] {
  const children = new Map<string, StoredItem[]>();
  for (const item of items) {
    if (item.parentId === null) continue;
    const siblings = children.get(item.parentId) ?? [];
    siblings.push(item);
    children.set(item.parentId, siblings);
  }
  const subtree: StoredItem[] = [];
  const visited = new Set<string>();
  const pending = [requireItem(items, rootId)];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item || visited.has(item.id)) continue;
    visited.add(item.id);
    subtree.push(item);
    pending.push(...(children.get(item.id) ?? []));
  }
  return subtree;
}

export async function deleteItem(
  projectId: string,
  itemId: string,
): Promise<string[]> {
  return mutateTree(projectId, async (transaction, items) => {
    const item = requireItem(items, itemId);
    const subtree = collectSubtree(items, item.id);
    // The ItemTree foreign key is NO ACTION, which PostgreSQL checks at the
    // end of the statement, so one statement can delete the whole subtree.
    await transaction.item.deleteMany({
      where: { id: { in: subtree.map((descendant) => descendant.id) } },
    });
    const survivors = siblingsOf(items, item.parentId).filter(
      (sibling) => sibling.id !== item.id,
    );
    await normalizeSiblings(transaction, survivors, item.parentId);
    return subtree.map((descendant) => descendant.id);
  });
}
