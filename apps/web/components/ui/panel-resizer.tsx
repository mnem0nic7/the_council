"use client";

export function PanelResizer({
  onPointerDown,
  onDoubleClick,
  onKeyDown,
  isResizing,
  minWidth,
  maxWidth,
  leftPanelWidth,
  label,
  testId
}: {
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  isResizing: boolean;
  minWidth: number;
  maxWidth: number;
  leftPanelWidth: number;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(leftPanelWidth)}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={`group relative flex h-full min-h-[42rem] w-6 cursor-col-resize items-center justify-center rounded-full border border-transparent transition ${
        isResizing
          ? "border-cyan-300/40 bg-cyan-300/10"
          : "hover:border-cyan-300/20 hover:bg-cyan-300/5"
      }`}
    >
      <span className="h-full w-px bg-cyan-300/18 transition group-hover:bg-cyan-200/40" />
      <span className="absolute flex h-16 w-3 items-center justify-center rounded-full border border-cyan-300/20 bg-[rgba(5,18,31,0.92)]">
        <span className="h-8 w-px bg-cyan-200/60 shadow-[0_0_10px_rgba(118,244,255,0.45)]" />
      </span>
    </button>
  );
}
