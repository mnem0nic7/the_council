"use client";

import { cn } from "../../lib/utils/cn";

export function EmptyState({
  message,
  className,
}: {
  message: string;
  className?: string;
}) {
  return (
    <p className={cn("py-6 text-center text-sm text-slate-500", className)}>
      {message}
    </p>
  );
}
