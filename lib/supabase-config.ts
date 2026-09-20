import { createClient, SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseBrowserConfig {
  url: string;
  anonKey: string;
}

const STORAGE_KEY = "veylnor_supabase_config";

/**
 * Only the Supabase Project URL and anon/public key ever live in the
 * browser. The service-role key never comes near this file - it stays a
 * server-only env var (see lib/supabase-server.ts).
 */
export function loadSupabaseConfig(): SupabaseBrowserConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url === "string" && typeof parsed?.anonKey === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveSupabaseConfig(config: SupabaseBrowserConfig) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearSupabaseConfig() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export function createBrowserSupabaseClient(config: SupabaseBrowserConfig): SupabaseClient {
  return createClient(config.url, config.anonKey);
}
