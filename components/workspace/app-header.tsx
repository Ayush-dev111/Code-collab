import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";
import { Icon } from "@/components/ui/icon";

export function AppHeader({ name }: { name: string }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-[#f6f8fa] dark:bg-[#010409] px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <Link
          href="/projects"
          className="flex shrink-0 items-center gap-2.5 text-foreground hover:opacity-85 transition-opacity"
          aria-label="Collab home"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-foreground text-background">
            <Icon name="github" className="size-5 fill-current" />
          </span>
          <span className="font-semibold text-sm sm:text-base tracking-tight flex items-center gap-1.5">
            collab
            <span className="rounded-md border border-border bg-secondary/80 px-1.5 py-0.5 text-[10px] font-mono font-normal text-muted-foreground">
              workspace
            </span>
          </span>
        </Link>
        <span className="text-muted-foreground/40 hidden sm:inline">/</span>
        <nav
          aria-label="Main navigation"
          className="hidden sm:flex items-center gap-1"
        >
          <Link
            href="/projects"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs sm:text-sm font-medium text-foreground hover:bg-secondary/70 transition-colors"
          >
            <Icon name="repo" className="size-4 text-muted-foreground" />
            Repositories
          </Link>
        </nav>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <div className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-xs w-48 lg:w-56">
          <Icon name="search" className="size-3.5" />
          <span className="flex-1 truncate">Type / to search</span>
          <kbd className="rounded border border-border bg-secondary px-1 text-[10px] font-mono text-muted-foreground">
            /
          </kbd>
        </div>
        <ThemeSwitcher />
        <div className="h-5 w-px bg-border hidden sm:block" />
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-blue-soft font-mono text-xs font-semibold text-blue"
          >
            {name.slice(0, 1).toUpperCase() || "?"}
          </span>
          <span className="hidden max-w-28 truncate text-xs font-medium lg:block text-foreground">
            {name}
          </span>
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
