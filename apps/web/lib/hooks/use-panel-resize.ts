"use client";

import { useEffect, useRef, useState } from "react";

export function usePanelResize(
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  clamp: (value: number) => number
) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(() => {
    if (typeof window === "undefined") {
      return defaultWidth;
    }
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultWidth;
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(storageKey, String(leftPanelWidth));
  }, [leftPanelWidth, storageKey]);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    const updateWidth = (clientX: number) => {
      const rect = layoutRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) {
        return;
      }
      const next = ((clientX - rect.left) / rect.width) * 100;
      setLeftPanelWidth(clamp(next));
    };

    const handlePointerMove = (event: PointerEvent) => {
      updateWidth(event.clientX);
    };

    const handlePointerUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [clamp, isResizing]);

  function beginResize(clientX: number) {
    const rect = layoutRef.current?.getBoundingClientRect();
    if (rect && rect.width > 0) {
      const next = ((clientX - rect.left) / rect.width) * 100;
      setLeftPanelWidth(clamp(next));
    }
    setIsResizing(true);
  }

  function nudgeResize(delta: number) {
    setLeftPanelWidth((current) => clamp(current + delta));
  }

  return {
    layoutRef,
    leftPanelWidth,
    isResizing,
    minWidth,
    maxWidth,
    defaultWidth,
    beginResize,
    nudgeResize,
    setLeftPanelWidth
  };
}
