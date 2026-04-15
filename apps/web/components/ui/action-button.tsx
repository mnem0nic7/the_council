"use client";

export function ActionButton({
  label,
  onClick,
  disabled,
  tone
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone: "primary" | "warning" | "danger" | "muted";
}) {
  const className =
    tone === "primary"
      ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100 hover:border-cyan-200 hover:bg-cyan-200/15"
      : tone === "warning"
        ? "border-amber-300/30 bg-amber-300/10 text-amber-100 hover:border-amber-200 hover:bg-amber-200/15"
        : tone === "danger"
          ? "border-rose-300/30 bg-rose-300/10 text-rose-100 hover:border-rose-200 hover:bg-rose-200/15"
          : "border-white/10 bg-white/5 text-slate-200 hover:border-cyan-300/30";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-full border px-4 py-2 text-xs uppercase tracking-[0.18em] transition ${className} disabled:opacity-50`}
    >
      {label}
    </button>
  );
}
