import { NextRequest, NextResponse } from "next/server";
import { getRenderJob } from "@/lib/render-jobs";
import { requireVeylnorApiKey } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = requireVeylnorApiKey(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const job = getRenderJob(params.id);
  if (!job) return NextResponse.json({ error: "Reel job not found or expired." }, { status: 404 });

  return NextResponse.json({
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    jobId: job.id,
    url: job.url ?? null,
    path: job.path ?? null,
    error: job.error ?? null,
    currentClip: job.currentClip ?? null,
    totalClips: job.totalClips,
  });
}
