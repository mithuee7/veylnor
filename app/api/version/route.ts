import { NextResponse } from "next/server";
import { SELECTION_VERSION } from "@/lib/stable-source";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Open /api/version in a browser to see exactly which build is live on Render. */
export async function GET() {
  return NextResponse.json({
    selectionVersion: SELECTION_VERSION,
    commit: process.env.RENDER_GIT_COMMIT ?? "unknown (not running on Render)",
    branch: process.env.RENDER_GIT_BRANCH ?? null,
    ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg (from PATH)",
    sceneThreshold: Number(process.env.VEYNLOR_SCENE_THRESHOLD ?? 0.2),
  });
}
