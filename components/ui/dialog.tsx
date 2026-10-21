"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onOpenChange(false);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
      className="m-auto max-h-[90dvh] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-md border border-border bg-card p-0 text-foreground shadow-2xl backdrop:bg-black/60"
    >
      <div className="flex items-center justify-between border-b border-border bg-secondary/30 px-4 py-3">
        <h2 id={titleId} className="text-sm font-semibold text-foreground">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close dialog"
          onClick={() => onOpenChange(false)}
          className="size-6 p-0 text-muted-foreground hover:text-foreground"
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>
      <div className="p-4">
        <p
          id={descriptionId}
          className="mb-4 text-xs leading-relaxed text-muted-foreground"
        >
          {description}
        </p>
        <div>{children}</div>
      </div>
    </dialog>
  );
}
