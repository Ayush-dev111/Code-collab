import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-8 sm:h-9 w-full rounded-md border border-border bg-card px-3 py-1.5 text-xs sm:text-sm text-foreground placeholder:text-muted-foreground transition-all shadow-xs focus-visible:border-blue focus-visible:ring-2 focus-visible:ring-blue/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-secondary/50 disabled:opacity-60 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
