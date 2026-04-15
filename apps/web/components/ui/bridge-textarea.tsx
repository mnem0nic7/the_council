"use client";

import { cn } from "../../lib/utils/cn";

export function BridgeTextarea({
  className,
  minRows,
  style,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  className?: string;
  minRows?: number;
}) {
  const minHeightStyle =
    minRows !== undefined ? { minHeight: `${minRows * 1.5}rem` } : undefined;

  return (
    <textarea
      {...props}
      style={{ ...minHeightStyle, ...style }}
      className={cn(
        "w-full rounded-[1.5rem] border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-cyan-300/50",
        className
      )}
    />
  );
}
