import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type ButtonProps = ComponentProps<"button"> & {
  variant?: "default" | "primary" | "outline" | "ghost" | "destructive";
  size?: "default" | "sm";
};

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-xs sm:text-sm font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue disabled:cursor-not-allowed disabled:opacity-50 select-none",
        size === "sm"
          ? "h-7 sm:h-8 px-2.5 py-1 text-xs"
          : "h-8 sm:h-9 px-3.5 py-1.5",
        (variant === "default" || variant === "primary") &&
          "bg-[#1f883d] text-white shadow-[0_1px_0_rgba(27,31,36,0.1)] border border-[rgba(27,31,36,0.15)] hover:bg-[#1a7f37] active:bg-[#187733] active:shadow-[inset_0_1px_0_rgba(20,70,32,0.2)] dark:bg-[#238636] dark:border-[rgba(240,246,252,0.1)] dark:hover:bg-[#2ea043] dark:active:bg-[#29903b]",
        variant === "destructive" &&
          "bg-[#cf222e] text-white shadow-[0_1px_0_rgba(27,31,36,0.1)] border border-[rgba(27,31,36,0.15)] hover:bg-[#a40e26] active:bg-[#82071e] dark:bg-[#da3633] dark:border-[rgba(240,246,252,0.1)] dark:hover:bg-[#f85149] dark:active:bg-[#b62324]",
        variant === "outline" &&
          "border border-border bg-[#f6f8fa] text-foreground shadow-[0_1px_0_rgba(27,31,36,0.04)] hover:bg-[#f3f4f6] active:bg-[#ebecf0] dark:bg-[#21262d] dark:text-[#c9d1d9] dark:hover:bg-[#30363d] dark:hover:border-[#8b949e] dark:active:bg-[#282e33]",
        variant === "ghost" &&
          "text-muted-foreground hover:bg-[#f6f8fa] hover:text-foreground dark:hover:bg-[#21262d] dark:hover:text-[#f0f6fc]",
        className,
      )}
      {...props}
    />
  );
}
