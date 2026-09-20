"use client";

import { ReactNode } from "react";
import { SupabaseConfigProvider } from "@/contexts/SupabaseConfigContext";

export default function Providers({ children }: { children: ReactNode }) {
  return <SupabaseConfigProvider>{children}</SupabaseConfigProvider>;
}
