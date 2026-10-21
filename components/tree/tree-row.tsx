"use client";

import Link from "next/link";
import { useState } from "react";
import type { TreeItem } from "@/lib/shared";
import { Button } from "@/components/ui/button";
import { childrenOf } from "./tree-utils";
import { Icon } from "@/components/ui/icon";

export type TreeAction = {
  action: "rename" | "move" | "delete" | "create";
  item: TreeItem;
};

export function TreeRows({
  projectId,
  items,
  parentId = null,
  selectedItemId,
  editable,
  online,
  onAction,
  onSelect,
}: {
  projectId: string;
  items: TreeItem[];
  parentId?: string | null;
  selectedItemId?: string | undefined;
  editable: boolean;
  online: boolean;
  onAction: (action: TreeAction) => void;
  onSelect: () => void;
}) {
  return (
    <ul
      className="space-y-1"
      aria-label={
        parentId ? "Nested items" : "Project pages, code files and folders"
      }
    >
      {childrenOf(items, parentId).map((item) => (
        <TreeRow
          key={item.id}
          projectId={projectId}
          items={items}
          item={item}
          selectedItemId={selectedItemId}
          editable={editable}
          online={online}
          onAction={onAction}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  projectId,
  items,
  item,
  selectedItemId,
  editable,
  online,
  onAction,
  onSelect,
}: {
  projectId: string;
  items: TreeItem[];
  item: TreeItem;
  selectedItemId?: string | undefined;
  editable: boolean;
  online: boolean;
  onAction: (action: TreeAction) => void;
  onSelect: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const folder = item.type === "FOLDER";
  const childCount = childrenOf(items, item.id).length;
  const rowClass = `flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-mono transition-colors ${selectedItemId === item.id ? "bg-secondary text-foreground font-semibold border-l-2 border-blue" : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"}`;
  return (
    <li>
      <div className="group/tree flex items-center gap-0.5">
        {folder ? (
          <button
            className={rowClass}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon
              name="chevron"
              className={`size-3 shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            <Icon name="folder" className="size-4 shrink-0" />
            <span className="truncate">{item.title}</span>
            <span className="sr-only"> folder, {childCount} items</span>
          </button>
        ) : (
          <Link
            href={`/projects/${projectId}/${item.id}`}
            aria-current={selectedItemId === item.id ? "page" : undefined}
            onNavigate={onSelect}
            className={rowClass}
          >
            <span
              aria-hidden="true"
              className="shrink-0 text-xs text-muted-foreground"
            >
              <Icon name={item.type === "CODE" ? "code" : "file"} />
            </span>
            <span className="truncate">{item.title}</span>
          </Link>
        )}
        {editable && (
          <details className="relative shrink-0">
            <summary
              className="flex size-8 cursor-pointer list-none items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary"
              aria-label={`Actions for ${item.title}`}
            >
              <Icon name="more" />
            </summary>
            <div className="absolute right-0 z-20 min-w-36 rounded-lg border bg-card p-1 shadow-lg">
              {folder && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start"
                  disabled={!online}
                  onClick={() => onAction({ action: "create", item })}
                >
                  Add inside
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={!online}
                onClick={() => onAction({ action: "rename", item })}
              >
                Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                disabled={!online}
                onClick={() => onAction({ action: "move", item })}
              >
                Move / reorder
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-destructive"
                disabled={!online}
                onClick={() => onAction({ action: "delete", item })}
              >
                Delete
              </Button>
            </div>
          </details>
        )}
      </div>
      {folder && expanded && childCount > 0 && (
        <div className="ml-3 border-l pl-2">
          <TreeRows
            projectId={projectId}
            items={items}
            parentId={item.id}
            selectedItemId={selectedItemId}
            editable={editable}
            online={online}
            onAction={onAction}
            onSelect={onSelect}
          />
        </div>
      )}
    </li>
  );
}
