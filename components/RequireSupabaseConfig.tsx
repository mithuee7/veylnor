"use client";

import { ReactNode } from "react";
import { useSupabaseConfig } from "@/contexts/SupabaseConfigContext";
import SupabaseSetup from "@/components/SupabaseSetup";

export default function RequireSupabaseConfig({ children }: { children: ReactNode }) {
  const { isConfigured, loaded } = useSupabaseConfig();

  if (!loaded) {
    return <p className="text-muted text-sm">Loading…</p>;
  }

  if (!isConfigured) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="font-display text-3xl text-ink mb-1">Connect Supabase</h1>
          <p className="text-muted text-sm">
            Set this up once - the site will remember it on this device.
          </p>
        </div>
        <SupabaseSetup />
      </div>
    );
  }

  return <>{children}</>;
}
