"use client";

import { codeFontSizeSchema } from "@/lib/shared";

export type CodeTheme = "light" | "vs-dark";
export type EditorTheme = CodeTheme | "system";
export function EditorSettings({
  theme,
  fontSize,
  onTheme,
  onFontSize,
}: {
  theme: EditorTheme;
  fontSize: number;
  onTheme: (value: EditorTheme) => void;
  onFontSize: (value: number) => void;
}) {
  return (
    <div className="grid w-full gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
      <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs font-medium sm:flex">
        <span className="text-muted-foreground text-xs">Font size</span>
        <input
          aria-label="Code font size"
          type="number"
          min={10}
          max={28}
          value={fontSize}
          className="h-7 w-16 rounded-md border border-border bg-card px-2 text-xs font-mono text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
          onChange={(event) => {
            const size = codeFontSizeSchema.safeParse(event.target.value);
            if (size.success) onFontSize(size.data);
          }}
        />
      </label>
      <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs font-medium sm:flex">
        <span className="text-muted-foreground text-xs">Appearance</span>
        <select
          aria-label="Code editor appearance"
          value={theme}
          onChange={(event) => onTheme(event.target.value as EditorTheme)}
          className="h-7 w-full min-w-0 rounded-md border border-border bg-card px-2 text-xs font-mono text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue sm:w-auto"
        >
          <option value="system">Follow app</option>
          <option value="light">Light</option>
          <option value="vs-dark">Dark</option>
        </select>
      </label>
    </div>
  );
}
