"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipCategory } from "./ClipCategoryManager";

interface Props {
  value: string;
  categories: ClipCategory[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function CategorySelect({ value, categories, onChange, disabled, placeholder = "All folders" }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = categories.find((category) => category.name === value)?.name;

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative min-w-[210px]">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="w-full h-10 rounded border border-panelBorder bg-base px-3 text-sm text-ink inline-flex items-center justify-between gap-3 disabled:opacity-50 hover:border-gold/50 transition"
      >
        <span className={selected ? "truncate" : "text-muted truncate"}>{selected ?? placeholder}</span>
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1.5 z-50 w-full overflow-hidden rounded-md border border-panelBorder bg-panel shadow-2xl"
        >
          <div className="max-h-64 overflow-y-auto p-1">
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => choose("")}
              className={`w-full rounded px-3 py-2.5 text-left text-sm transition ${!value ? "bg-white/6 text-goldSoft" : "text-ink hover:bg-white/5"}`}
            >
              {placeholder}
            </button>
            {categories.map((category) => {
              const active = category.name === value;
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  key={category.id}
                  onClick={() => choose(category.name)}
                  className={`w-full rounded px-3 py-2.5 text-left text-sm transition ${active ? "bg-white/6 text-goldSoft" : "text-ink hover:bg-white/5"}`}
                >
                  {category.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
