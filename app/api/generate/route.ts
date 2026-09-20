import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { buildReelSequence } from "@/lib/sequence-pipeline";
import { BeatInfo, Clip, OrderedClip, ReferenceAnalysis } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { beatInfo, references: bodyReferences, reference: legacyReference, reelInstructions, locked, avoidOrderClipIds } = body as {
      beatInfo: BeatInfo;
      references?: ReferenceAnalysis[] | null;
      reference?: ReferenceAnalysis | null;
      reelInstructions?: string;
      locked?: (OrderedClip & { sourceStart?: number; sourceEnd?: number })[];
      avoidOrderClipIds?: string[][];
    };
    if (!beatInfo || !beatInfo.numCuts || !Array.isArray(beatInfo.segmentDurations)) {
      return NextResponse.json({ error: "A valid analyzed song section is required." }, { status: 400 });
    }

    const [{ data: clips, error: clipsError }, { data: categories, error: categoriesError }] = await Promise.all([
      supabaseServer.from("clips").select("*"),
      supabaseServer.from("clip_categories").select("name").order("name", { ascending: true }),
    ]);
    if (clipsError) return NextResponse.json({ error: clipsError.message }, { status: 500 });
    if (categoriesError) return NextResponse.json({ error: categoriesError.message }, { status: 500 });
    if (!clips?.length) return NextResponse.json({ error: "No clips uploaded yet." }, { status: 400 });
    const availableCategories = (categories ?? []).map((category) => String(category.name)).filter(Boolean);
    if (!availableCategories.length) return NextResponse.json({ error: "No clip folders are configured." }, { status: 400 });

    const references = Array.isArray(bodyReferences) ? bodyReferences.filter(Boolean) : (legacyReference ? [legacyReference] : []);
    // Same pipeline as the n8n API (/api/v1/reels): constraints -> Groq -> validation -> FFmpeg shot selection.
    const result = await buildReelSequence({
      clips: clips as Clip[], availableCategories, beatInfo, references, reelInstructions, locked, avoidOrderClipIds,
    });
    return NextResponse.json({ clips: result.items, warning: result.warning ?? null, constraints: result.constraintNotes });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Generation failed." }, { status: 500 });
  }
}
