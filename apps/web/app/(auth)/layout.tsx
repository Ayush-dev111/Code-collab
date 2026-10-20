import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeSwitcher } from "@/components/ui/theme-switcher";
import { Icon } from "@/components/ui/icon";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh flex flex-col justify-between bg-background px-4 py-8 sm:px-6">
      <div className="flex justify-end">
        <ThemeSwitcher />
      </div>

      <div className="mx-auto w-full max-w-[340px] sm:max-w-[380px] my-auto">
        <div className="text-center mb-6">
          <Link
            href="/"
            className="inline-flex size-12 items-center justify-center rounded-full text-foreground hover:opacity-85 transition-opacity"
            aria-label="Collab home"
          >
            <Icon name="github" className="size-10 fill-current" />
          </Link>
        </div>
        {children}
      </div>

      <footer className="mt-8 text-center text-xs text-muted-foreground space-y-2">
        <div className="flex justify-center gap-4 text-muted-foreground/80 text-[11px]">
          <span className="hover:text-blue cursor-pointer">Terms</span>
          <span className="hover:text-blue cursor-pointer">Privacy</span>
          <span className="hover:text-blue cursor-pointer">Docs</span>
          <span className="hover:text-blue cursor-pointer">Contact Support</span>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Collab platform &middot; Built for teams to write, code, and build together.
        </p>
      </footer>
    </main>
  );
}
