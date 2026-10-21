"use client";

import { useTheme } from "@/components/theme-provider";
import { Icon } from "./icon";
import { cn } from "@/lib/utils";

const options = [
  { value: "light", icon: "sun", label: "Light theme" },
  { value: "dark", icon: "moon", label: "Dark theme" },
  { value: "system", icon: "monitor", label: "System theme" },
] as const;

export function ThemeSwitcher() {
  const { preference, setPreference } = useTheme();
  return (
    <div
      role="group"
      aria-label="Appearance"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-secondary/60 p-0.5 shadow-2xs"
    >
      {options.map(({ value, icon, label }) => (
        <button
          key={value}
          type="button"
          aria-label={label}
          aria-pressed={preference === value}
          title={label}
          onClick={() => setPreference(value)}
          className={cn(
            "flex size-6 items-center justify-center rounded transition-colors sm:size-7",
            preference === value
              ? "bg-card text-foreground shadow-2xs border border-border/80"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon name={icon} className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
