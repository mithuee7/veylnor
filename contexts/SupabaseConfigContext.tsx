"use client";

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { SupabaseClient } from "@supabase/supabase-js";
import {
  SupabaseBrowserConfig,
  loadSupabaseConfig,
  saveSupabaseConfig,
  clearSupabaseConfig,
  createBrowserSupabaseClient,
} from "@/lib/supabase-config";

interface SupabaseConfigContextValue {
  config: SupabaseBrowserConfig | null;
  client: SupabaseClient | null;
  isConfigured: boolean;
  loaded: boolean; // true once we've checked localStorage on mount
  save: (config: SupabaseBrowserConfig) => void;
  clear: () => void;
}

const SupabaseConfigContext = createContext<SupabaseConfigContextValue | null>(null);

export function SupabaseConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<SupabaseBrowserConfig | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setConfig(loadSupabaseConfig());
    setLoaded(true);
  }, []);

  const client = useMemo(() => {
    if (!config) return null;
    try {
      return createBrowserSupabaseClient(config);
    } catch {
      return null;
    }
  }, [config]);

  function save(next: SupabaseBrowserConfig) {
    saveSupabaseConfig(next);
    setConfig(next);
  }

  function clear() {
    clearSupabaseConfig();
    setConfig(null);
  }

  const value: SupabaseConfigContextValue = {
    config,
    client,
    isConfigured: Boolean(config && client),
    loaded,
    save,
    clear,
  };

  return (
    <SupabaseConfigContext.Provider value={value}>{children}</SupabaseConfigContext.Provider>
  );
}

export function useSupabaseConfig() {
  const ctx = useContext(SupabaseConfigContext);
  if (!ctx) {
    throw new Error("useSupabaseConfig must be used inside SupabaseConfigProvider");
  }
  return ctx;
}
