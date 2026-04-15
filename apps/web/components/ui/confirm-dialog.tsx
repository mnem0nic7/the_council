"use client";

import { useEffect, useRef } from "react";
import { cn } from "../../lib/utils/cn";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onCancel();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => dialog.removeEventListener("cancel", handleCancel);
  }, [onCancel]);

  return (
    <dialog
      ref={ref}
      className={cn(
        "rounded-[1.8rem] border border-white/15 bg-slate-950 p-6 max-w-md w-full backdrop:bg-black/60"
      )}
    >
      <h2 className="text-lg font-semibold text-white mb-2">{title}</h2>
      <p className="text-sm text-slate-300 mb-5">{message}</p>
      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs uppercase tracking-[0.18em] text-slate-300 transition hover:border-white/20 hover:bg-white/10"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-full border border-amber-500/40 bg-gradient-to-r from-amber-500/20 to-rose-500/20 px-4 py-2 text-xs uppercase tracking-[0.18em] text-amber-100 transition hover:border-amber-400/60 hover:from-amber-500/30 hover:to-rose-500/30"
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
