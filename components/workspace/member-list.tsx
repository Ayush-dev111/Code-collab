import type { ProjectDetails } from "@/lib/shared";
import { RoleBadge } from "@/components/projects/role-badge";

export function MemberList({
  members,
}: {
  members: ProjectDetails["members"];
}) {
  return (
    <section aria-labelledby="members-title">
      <div className="flex items-center justify-between">
        <h2
          id="members-title"
          className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Members
        </h2>
        <span className="text-xs text-muted-foreground">{members.length}</span>
      </div>
      <ul className="mt-4 space-y-4">
        {members.map((member) => (
          <li key={member.id} className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-card text-xs font-medium text-muted-foreground"
            >
              {member.name.slice(0, 1).toUpperCase() || "?"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={member.name}
            >
              {member.name}
            </span>
            <RoleBadge role={member.role} />
          </li>
        ))}
      </ul>
    </section>
  );
}
