"use client";

import { cn } from "../../lib/utils/cn";

export function FieldLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "mb-2 block text-xs uppercase tracking-[0.2em] text-slate-400",
        className
      )}
    >
      {children}
    </span>
  );
}
