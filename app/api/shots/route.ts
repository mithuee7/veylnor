import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { selectShotWindow } from "@/lib/stable-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 90;

/**
 * Picks an uninterrupted section of `target` seconds inside one continuous shot of a clip.
 * Used when the user manually replaces a clip in the sequence editor, so manual swaps get the
 * same middle -> end -> beginning, never-cross-a-cut selection as generated sequences.
 */
export async function POST(req: NextRequest) {
  try {
    const { clipId, target } = (await req.json()) as { clipId?: string; target?: number };
    const slot = Number(target);
    if (!clipId || !(slot > 0)) return NextResponse.json({ error: "clipId and a positive target are required." }, { status: 400 });
    const { data: clip, error } = await supabaseServer.from("clips").select("*").eq("id", clipId).single();
    if (error || !clip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    const signed = await supabaseServer.storage.from("clips").createSignedUrl(clip.storage_path, 15 * 60);
    if (!signed.data?.signedUrl) return NextResponse.json({ error: "Could not access the clip." }, { status: 500 });
    const selection = await selectShotWindow({ cacheKey: clip.id, url: signed.data.signedUrl, target: slot, sourceDuration: clip.duration });
    return NextResponse.json(selection);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Shot selection failed." }, { status: 500 });
  }
}
