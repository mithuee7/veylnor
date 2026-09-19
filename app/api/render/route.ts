import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase-server";
import { getRenderJob, startRenderJob } from "@/lib/render-jobs";
import { TextOverlay } from "@/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  songId: string;
  songStart: number;
  songEnd: number;
  sequence: { clipId: string; start: number; end: number; targetDuration?: number }[];
  textOverlay?: TextOverlay;
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("jobId");
  if (!id) return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  const job = getRenderJob(id);
  if (!job) return NextResponse.json({ error: "Render job not found or expired." }, { status: 404 });
  return NextResponse.json(job);
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Body;
    if (!body.songId || !Array.isArray(body.sequence) || !body.sequence.length) {
      return NextResponse.json({ error: "songId and sequence are required" }, { status: 400 });
    }
    if (!(body.songEnd > body.songStart) || body.songStart < 0) {
      return NextResponse.json({ error: "Invalid song section" }, { status: 400 });
    }

    const { data: song, error: songError } = await supabaseServer
      .from("songs").select("*").eq("id", body.songId).single();
    if (songError || !song) return NextResponse.json({ error: "Source song not found." }, { status: 404 });

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

    const ids = body.sequence.map(x => x.clipId);
    const { data: clips, error: clipError } = await supabaseServer.from("clips").select("*").in("id", ids);
    if (clipError) return NextResponse.json({ error: clipError.message }, { status: 500 });
    const byId = new Map((clips ?? []).map(c => [c.id, c]));
    if (ids.some(id => !byId.has(id))) {
      return NextResponse.json({ error: "One or more source clips no longer exist." }, { status: 400 });
    }

    const songSigned = await supabaseServer.storage.from("songs").createSignedUrl(song.storage_path, 15 * 60);
    if (!songSigned.data?.signedUrl) {
      return NextResponse.json({ error: "Could not access song in Supabase Storage." }, { status: 500 });
    }

    const renderClips = [];
    for (const item of body.sequence) {
      const clip = byId.get(item.clipId)!;
      const duration = Number(clip.duration ?? 0);
      const sourceSpan = Number(item.end) - Number(item.start);
      if (!(item.start >= 0 && item.end > item.start && (!duration || item.end <= duration + 0.05))) {
        return NextResponse.json({ error: `Invalid source section for ${clip.filename}.` }, { status: 400 });
      }
      if (item.targetDuration !== undefined) {
        const target = Number(item.targetDuration);
        if (!(target > 0) || Math.abs(sourceSpan - target) > 0.05) {
          return NextResponse.json({ error: `Source section for ${clip.filename} must preserve its ${target.toFixed(3)}s scene slot.` }, { status: 400 });
        }
      }
      const signed = await supabaseServer.storage.from("clips").createSignedUrl(clip.storage_path, 15 * 60);
      if (!signed.data?.signedUrl) {
        return NextResponse.json({ error: `Could not access ${clip.filename}.` }, { status: 500 });
      }
      renderClips.push({
        url: signed.data.signedUrl,
        start: item.start,
        end: item.end,
        targetDuration: item.targetDuration,
        sourceDuration: duration,
      });
    }

    const job = startRenderJob({
      clips: renderClips,
      songUrl: songSigned.data.signedUrl,
      songStart: body.songStart,
      songEnd: body.songEnd,
      textOverlay,
    });

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      width: 1080,
      height: 1920,
    }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Render request failed." }, { status: 500 });
  }
}
