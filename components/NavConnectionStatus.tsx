"use client";

import Link from "next/link";
import { useSupabaseConfig } from "@/contexts/SupabaseConfigContext";

export default function NavConnectionStatus() {
  const { isConfigured, loaded } = useSupabaseConfig();

  return (
    <Link
      href="/settings"
      className="flex items-center gap-2 text-sm text-muted hover:text-ink transition-colors"
      title={isConfigured ? "Supabase connected" : "Supabase not configured"}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          !loaded ? "bg-muted" : isConfigured ? "bg-emerald-400" : "bg-red-400"
        }`}
      />
      Settings
    </Link>
  );
}
