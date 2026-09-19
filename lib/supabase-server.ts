import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Service-role client. NEVER import this from a client component.
// Used only inside app/api/** route handlers. SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are plain (non-NEXT_PUBLIC) server env vars -
// they must never reach the browser bundle.
//
// Lazily initialized so importing this module (e.g. during `next build`
// route collection) never fails - only calling it without the env vars
// set at runtime does, with a clear error message.
let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as server environment variables."
    );
  }

  client = createClient(url, serviceKey, { auth: { persistSession: false } });
  return client;
}

export const supabaseServer = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver);
  },
});
