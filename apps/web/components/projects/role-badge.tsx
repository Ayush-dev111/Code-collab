import type { Role } from "@collab/shared";
import { cn } from "@/lib/utils";

const labels: Record<Role, string> = {
  OWNER: "Owner",
  EDITOR: "Editor",
  VIEWER: "Viewer",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none",
        role === "OWNER"
          ? "border-success/30 bg-success-soft text-success"
          : role === "EDITOR"
            ? "border-blue/30 bg-blue-soft text-blue"
            : "border-border bg-secondary text-muted-foreground",
      )}
    >
      {labels[role]}
    </span>
  );
}
