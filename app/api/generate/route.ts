import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { generateSequence } from "@/lib/generate";
import { BeatInfo, Clip, OrderedClip, ReferenceAnalysis } from "@/types";
import { findNoCutSection } from "@/lib/stable-source";

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
    const result = await generateSequence({
      clips: clips as Clip[], beatInfo, references, reelInstructions, locked, avoidOrderClipIds, availableCategories,
    });
    const clipsById = new Map((clips as Clip[]).map(c => [c.id, c]));

    const prepared = await Promise.all(result.ordered.map(async (item, index) => {
      const clip = clipsById.get(item.clip_id)!;
      const signed = await supabaseServer.storage.from("clips").createSignedUrl(clip.storage_path, 60 * 60);
      const target = Number(beatInfo.segmentDurations[index] ?? 0.5);
      const sourceDuration = Number(clip.duration ?? target);
      const lock = locked?.find(x => x.position === index + 1 && x.clip_id === clip.id);
      const maxStart = Math.max(0, sourceDuration - target);

      // Locked/manual source sections are authoritative and are never replaced by auto-selection.
      if (lock?.sourceStart !== undefined) {
        const sourceStart = Math.max(0, Math.min(Number(lock.sourceStart), maxStart));
        const end = sourceDuration >= target ? sourceStart + target : sourceDuration;
        return {
          ...item,
          position: index + 1,
          clip: { ...clip, url: signed.data?.signedUrl ?? null },
          sourceStart: Number(sourceStart.toFixed(3)),
          sourceEnd: Number(end.toFixed(3)),
          targetDuration: target,
          locked: true,
          _needsNoCut: false,
        };
      }

      return {
        ...item,
        position: index + 1,
        clip: { ...clip, url: signed.data?.signedUrl ?? null },
        sourceStart: 0,
        sourceEnd: Number(Math.min(target, sourceDuration).toFixed(3)),
        targetDuration: target,
        locked: false,
        _needsNoCut: sourceDuration >= target,
      };
    }));

    // AI has already selected the clips. NOW choose the source section for each selected clip.
    // This happens before the sequence reaches the UI/render endpoint, so rendering never performs analysis.
    const withUrls: Array<Omit<(typeof prepared)[number], "_needsNoCut">> = [];
    const analysisConcurrency = 2;
    for (let offset = 0; offset < prepared.length; offset += analysisConcurrency) {
      const batch = prepared.slice(offset, offset + analysisConcurrency);
      const analyzed = await Promise.all(batch.map(async (item) => {
        if (!item._needsNoCut || !item.clip.url) {
          const { _needsNoCut, ...publicItem } = item;
          return publicItem;
        }
        const selected = await findNoCutSection(item.clip.url, item.targetDuration, Number(item.clip.duration ?? item.targetDuration));
        const { _needsNoCut, ...publicItem } = item;
        return {
          ...publicItem,
          sourceStart: selected.start,
          sourceEnd: selected.end,
        };
      }));
      withUrls.push(...analyzed);
    }
    return NextResponse.json({ clips: withUrls, warning: result.warning ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Generation failed." }, { status: 500 });
  }
}
