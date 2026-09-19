"use client";

import SupabaseSetup from "@/components/SupabaseSetup";

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl text-ink mb-1">Settings</h1>
        <p className="text-muted text-sm">Manage this browser's Supabase connection.</p>
      </div>
      <SupabaseSetup />
    </div>
  );
}
