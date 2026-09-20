import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { buildReelSequence } from "@/lib/sequence-pipeline";
import { startRenderJob, waitForRenderJob } from "@/lib/render-jobs";
import { createApiActivity, updateApiActivity } from "@/lib/api-activity";
import { buildBeatLockedGrid } from "@/lib/beat-grid";
import { analyzeReferenceVideo } from "@/lib/reference-analysis";
import { BeatInfo, Clip, ReferenceAnalysis, TextOverlay } from "@/types";
import { requireVeylnorApiKey } from "@/lib/api-auth";
import { analyzeSongServer } from "@/lib/server-beat-analysis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 600;

type ReferenceInput = ReferenceAnalysis | { path: string };

interface RequestBody {
  songId: string;
  songStart?: number;
  songEnd?: number;
  bpm?: number;
  beatInfo?: BeatInfo;
  clipsPerBeat?: 1 | 2;
  references?: ReferenceInput[];
  reelInstructions?: string;
  locked?: Array<{
    position: number;
    clip_id: string;
    category: string;
    role?: string;
    sourceStart?: number;
    sourceEnd?: number;
  }>;
  avoidOrderClipIds?: string[][];
  textOverlay?: TextOverlay;
  render?: boolean;
}

async function analyzeReferencePaths(inputs: ReferenceInput[] = []) {
  const analyses: ReferenceAnalysis[] = [];
  for (const input of inputs.slice(0, 5)) {
    if (input && typeof input === "object" && "duration" in input && "cutTimestamps" in input) {
      analyses.push(input as ReferenceAnalysis);
      continue;
    }

    const path = String((input as { path?: string })?.path ?? "");
    if (!path.startsWith("reference_reels/")) {
      throw new Error("Reference paths must point to the private references bucket under reference_reels/.");
    }

    const signed = await supabaseServer.storage.from("references").createSignedUrl(path, 10 * 60);
    if (signed.error || !signed.data?.signedUrl) {
      throw new Error(signed.error?.message ?? "Could not access a reference reel.");
    }
    analyses.push(await analyzeReferenceVideo(signed.data.signedUrl));
  }
  return analyses;
}

function buildApiBeatInfo(body: RequestBody, songDuration: number) {
  if (body.beatInfo) {
    if (!Array.isArray(body.beatInfo.segmentDurations) || !body.beatInfo.segmentDurations.length) {
      throw new Error("beatInfo.segmentDurations must be a non-empty array.");
    }
    const durations = body.beatInfo.segmentDurations.map(Number);
    const total = durations.reduce((sum, value) => sum + value, 0);
    if (durations.some(value => !Number.isFinite(value) || value <= 0) || Math.abs(total - songDuration) > 0.1) {
      throw new Error("beatInfo.segmentDurations must be positive and add up to the selected song section.");
    }
    return {
      ...body.beatInfo,
      numCuts: durations.length,
      duration: Number(songDuration.toFixed(3)),
      segmentDurations: durations.map(value => Number(value.toFixed(3))),
    };
  }

  const bpm = Number(body.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0 || bpm > 300) {
    throw new Error("BPM was not supplied. The API must analyze the selected song section before generating the reel.");
  }

  const clipsPerBeat = body.clipsPerBeat === 2 ? 2 : 1;
  const grid = buildBeatLockedGrid(songDuration, bpm, clipsPerBeat);

  return {
    bpm: Math.round(bpm * 10) / 10,
    beatTimestamps: grid.cuts,
    cutTimestamps: grid.cuts,
    windowStart: 0,
    windowEnd: songDuration,
    numCuts: grid.segmentDurations.length,
    duration: Number(songDuration.toFixed(3)),
    segmentDurations: grid.segmentDurations,
    clipsPerBeat,
  } satisfies BeatInfo;
}

export async function POST(req: NextRequest) {
  const auth = requireVeylnorApiKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let activity: ReturnType<typeof createApiActivity> | null = null;
  try {
    const body = (await req.json()) as RequestBody;
    activity = createApiActivity(body.songId);
    if (!body.songId) return NextResponse.json({ error: "songId is required." }, { status: 400 });

    const { data: song, error: songError } = await supabaseServer
      .from("songs")
      .select("*")
      .eq("id", body.songId)
      .single();

    if (songError || !song) return NextResponse.json({ error: "Source song not found." }, { status: 404 });
    updateApiActivity(activity.id, { songFilename: song.filename, stage: "Song loaded", progress: 8 });

    const songDuration = Number(song.duration ?? 0);
    const songStart = Number(body.songStart ?? 0);
    const defaultEnd = songDuration > songStart ? Math.min(songStart + 15, songDuration) : songStart + 15;
    const songEnd = Number(body.songEnd ?? defaultEnd);

    if (!(songEnd > songStart) || songStart < 0 || (songDuration > 0 && songEnd > songDuration + 0.05)) {
      return NextResponse.json({ error: "Invalid songStart/songEnd section." }, { status: 400 });
    }

    const sectionDuration = Number((songEnd - songStart).toFixed(3));
    const clipsPerBeat = body.clipsPerBeat === 2 ? 2 : 1;

    const songSignedForAnalysis = await supabaseServer.storage.from("songs").createSignedUrl(song.storage_path, 15 * 60);
    if (!songSignedForAnalysis.data?.signedUrl) throw new Error("Could not access song in Supabase Storage for BPM analysis.");

    let beatInfo: BeatInfo;
    if (body.beatInfo || Number.isFinite(Number(body.bpm))) {
      beatInfo = buildApiBeatInfo(body, sectionDuration);
    } else {
      updateApiActivity(activity.id, { stage: "Detecting BPM", progress: 11 });
      beatInfo = await analyzeSongServer(songSignedForAnalysis.data.signedUrl, songStart, songEnd, clipsPerBeat);
    }

    const [{ data: clips, error: clipsError }, { data: categories, error: categoriesError }, preference] = await Promise.all([
      supabaseServer.from("clips").select("*"),
      supabaseServer.from("clip_categories").select("name").order("name", { ascending: true }),
      supabaseServer.from("reel_preferences").select("instructions").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    if (clipsError) return NextResponse.json({ error: clipsError.message }, { status: 500 });
    if (categoriesError) return NextResponse.json({ error: categoriesError.message }, { status: 500 });
    if (!clips?.length) return NextResponse.json({ error: "No clips uploaded yet." }, { status: 400 });

    const availableCategories = (categories ?? []).map(c => String(c.name)).filter(Boolean);
    if (!availableCategories.length) return NextResponse.json({ error: "No clip folders are configured." }, { status: 400 });

    updateApiActivity(activity.id, { stage: "Analyzing reference reels", progress: 15 });
    const references = await analyzeReferencePaths(body.references ?? []);
    const reelInstructions = body.reelInstructions !== undefined
      ? String(body.reelInstructions).slice(0, 4000)
      : String(preference.data?.instructions ?? "");

    updateApiActivity(activity.id, { stage: "Generating clip sequence", progress: 30 });
    // Same pipeline as the web UI (/api/generate): constraints -> Groq -> validation -> FFmpeg shot selection.
    const result = await buildReelSequence({
      clips: clips as Clip[],
      availableCategories,
      beatInfo,
      references,
      reelInstructions,
      locked: body.locked,
      avoidOrderClipIds: body.avoidOrderClipIds,
    });
    const publicSequence = result.items;

    updateApiActivity(activity.id, { stage: "Finalizing clip timing", progress: 72 });
    const shouldRender = body.render !== false;

    if (!shouldRender) {
      updateApiActivity(activity.id, { status: "complete", stage: "Sequence ready", progress: 100 });
      return NextResponse.json({
        status: "generated",
        song: { id: song.id, filename: song.filename },
        songStart,
        songEnd,
        beatInfo,
        sequence: publicSequence,
        warning: result.warning ?? null,
        constraints: result.constraintNotes,
      });
    }

    const songSigned = songSignedForAnalysis;

    const renderClips = publicSequence.map(item => ({
      url: item.clip.url!,
      start: item.sourceStart,
      end: item.sourceEnd,
      targetDuration: item.targetDuration,
      sourceDuration: Number(item.clip.duration ?? 0),
    }));

    const textOverlay = body.textOverlay?.enabled && body.textOverlay.text?.trim()
      ? {
          enabled: true,
          text: String(body.textOverlay.text).trim().slice(0, 120),
          size: Math.max(40, Math.min(112, Number(body.textOverlay.size) || 64)),
          font: (["EB Garamond", "Inter", "Noto Sans", "DejaVu Sans"] as const).includes(body.textOverlay.font as any)
            ? body.textOverlay.font
            : "EB Garamond",
        }
      : undefined;

    updateApiActivity(activity.id, { stage: "Starting FFmpeg render", progress: 75 });
    const job = startRenderJob({
      clips: renderClips,
      songUrl: songSigned.data.signedUrl,
      songStart,
      songEnd,
      textOverlay,
      source: "api",
    });
    updateApiActivity(activity.id, { renderJobId: job.id, stage: job.stage, progress: 76 });

    const completed = await waitForRenderJob(job.id);
    updateApiActivity(activity.id, { status: "complete", stage: "MP4 ready", progress: 100 });

    return NextResponse.json({
      status: "complete",
      jobId: job.id,
      song: { id: song.id, filename: song.filename },
      songStart,
      songEnd,
      beatInfo,
      sequence: publicSequence,
      warning: result.warning ?? null,
      constraints: result.constraintNotes,
      reelUrl: completed.url,
      render: {
        status: completed.status,
        statusPath: `/api/v1/reels/${job.id}`,
      },
    });
  } catch (e: any) {
    if (activity) updateApiActivity(activity.id, { status: "failed", stage: "Generation failed", progress: 100, error: e?.message ?? "Reel generation failed." });
    console.error("[api/v1/reels]", e);
    return NextResponse.json({ error: e?.message ?? "Reel generation failed." }, { status: 500 });
  }
}
