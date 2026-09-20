import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";

export async function POST(req: NextRequest) {
  try {
    const { filename } = await req.json();
    if (!filename || typeof filename !== "string") {
      return NextResponse.json({ error: "Filename is required" }, { status: 400 });
    }
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `reference_reels/${Date.now()}-${safe}`;
    const { data, error } = await supabaseServer.storage.from("references").createSignedUploadUrl(path);
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not create upload URL" }, { status: 500 });
    return NextResponse.json({ path: data.path, token: data.token, bucket: "references" });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Upload URL failed" }, { status: 500 });
  }
}
