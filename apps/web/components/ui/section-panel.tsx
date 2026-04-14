"use client";

import { cn } from "../../lib/utils/cn";

export function SectionPanel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[1.8rem] border border-white/8 bg-black/15 p-4",
        className
      )}
    >
      {children}
    </div>
  );
}
