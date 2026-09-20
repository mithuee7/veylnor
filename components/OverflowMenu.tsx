"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface Props {
  label?: string;
  children: ReactNode;
}

export default function OverflowMenu({ label = "More options", children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="h-8 w-8 rounded border border-panelBorder text-muted hover:text-ink hover:border-gold/60 transition inline-flex items-center justify-center"
      >
        <span aria-hidden="true" className="tracking-[0.18em] leading-none -translate-y-[2px]">•••</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 z-50 min-w-[150px] rounded-md border border-panelBorder bg-panel p-1.5 shadow-2xl"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={`w-full rounded px-3 py-2 text-left text-xs transition disabled:opacity-40 ${danger ? "text-red-300 hover:bg-red-950/40" : "text-ink hover:bg-white/5"}`}
    >
      {children}
    </button>
  );
}
