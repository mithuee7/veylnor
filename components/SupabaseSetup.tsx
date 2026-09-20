"use client";

import { useState } from "react";
import { useSupabaseConfig } from "@/contexts/SupabaseConfigContext";

export default function SupabaseSetup({ compact = false }: { compact?: boolean }) {
  const { config, isConfigured, save, clear } = useSupabaseConfig();
  const [editing, setEditing] = useState(!isConfigured);
  const [url, setUrl] = useState(config?.url ?? "");
  const [anonKey, setAnonKey] = useState(config?.anonKey ?? "");
  const [error, setError] = useState("");

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const trimmedUrl = url.trim().replace(/\/$/, "");
    const trimmedKey = anonKey.trim();

    if (!/^https:\/\/.+\.supabase\.co$/.test(trimmedUrl)) {
      setError("Enter your Supabase Project URL, e.g. https://abcdefgh.supabase.co");
      return;
    }
    if (trimmedKey.length < 20) {
      setError("Enter your Supabase anon/public API key.");
      return;
    }

    save({ url: trimmedUrl, anonKey: trimmedKey });
    setEditing(false);
  }

  function handleClear() {
    clear();
    setUrl("");
    setAnonKey("");
    setEditing(true);
  }

  if (isConfigured && !editing) {
    return (
      <div className={compact ? "flex items-center gap-3" : "card p-5 space-y-3"}>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-sm text-ink">Supabase connected</span>
          {!compact && (
            <span className="text-xs text-muted truncate max-w-xs">{config?.url}</span>
          )}
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setEditing(true)}
            className="text-xs text-goldSoft hover:underline"
          >
            Edit
          </button>
          <button onClick={handleClear} className="text-xs text-red-400 hover:underline">
            Disconnect
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-6 max-w-md space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className={`w-2 h-2 rounded-full ${isConfigured ? "bg-emerald-400" : "bg-muted"}`} />
          <h2 className="font-display text-lg text-ink">Connect Supabase</h2>
        </div>
        <p className="text-sm text-muted">
          Enter your Supabase project's URL and anon/public key. These are saved only in this
          browser so you won't have to re-enter them on future visits.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <label className="label block mb-1">Supabase Project URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-project.supabase.co"
            className="w-full bg-base border border-panelBorder rounded px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="label block mb-1">Supabase anon/public key</label>
          <input
            type="password"
            value={anonKey}
            onChange={(e) => setAnonKey(e.target.value)}
            placeholder="eyJhbGciOi..."
            className="w-full bg-base border border-panelBorder rounded px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted mt-1">
            Never enter your service-role key here - only the public anon key.
          </p>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            className="px-4 py-2 rounded border border-gold text-goldSoft text-sm hover:bg-gold/10 transition-colors"
          >
            Save
          </button>
          {isConfigured && (
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="text-sm text-muted hover:text-ink"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
