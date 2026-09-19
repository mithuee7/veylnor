import { NextRequest, NextResponse } from "next/server";
import { startReferenceAnalysisJob, getReferenceJob } from "@/lib/reference-jobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: NextRequest) {
  try {
    const { path } = await req.json();
    if (!path || typeof path !== "string" || !path.startsWith("reference_reels/")) {
      return NextResponse.json({ error: "Invalid reference reel" }, { status: 400 });
    }
    const job = startReferenceAnalysisJob(path);
    return NextResponse.json({ jobId: job.id, status: job.status, progress: job.progress, stage: job.stage }, { status: 202 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Reference analysis failed." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("jobId");
  if (!id) return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  const job = getReferenceJob(id);
  if (!job) return NextResponse.json({ error: "Reference analysis job not found or expired." }, { status: 404 });
  return NextResponse.json(job);
}
