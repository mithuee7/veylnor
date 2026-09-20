import "server-only";
import { randomUUID } from "node:crypto";
import { supabaseServer } from "@/lib/supabase-server";
import { analyzeReferenceVideo } from "@/lib/reference-analysis";
import { ReferenceAnalysis } from "@/types";

type ReferenceJobStatus = "queued" | "analyzing" | "complete" | "failed";

export interface ReferenceJob {
  id: string;
  status: ReferenceJobStatus;
  progress: number;
  stage: string;
  path: string;
  analysis?: ReferenceAnalysis;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, ReferenceJob>();
const queue: string[] = [];
let active = false;

function cleanup() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) if (job.updatedAt < cutoff) jobs.delete(id);
  while (queue.length && !jobs.has(queue[0])) queue.shift();
}

async function pump() {
  if (active) return;
  cleanup();
  const id = queue.shift();
  if (!id) return;
  const job = jobs.get(id);
  if (!job) return pump();
  active = true;
  job.status = "analyzing";
  job.stage = "Preparing local analysis…";
  job.progress = Math.max(job.progress, 4);
  job.updatedAt = Date.now();
  try {
    const signed = await supabaseServer.storage.from("references").createSignedUrl(job.path, 10 * 60);
    if (signed.error || !signed.data?.signedUrl) throw new Error(signed.error?.message ?? "Could not access reference reel.");
    job.analysis = await analyzeReferenceVideo(signed.data.signedUrl, (progress, stage) => {
      job.progress = Math.max(0, Math.min(99, Math.round(progress)));
      job.stage = stage;
      job.updatedAt = Date.now();
    });
    job.progress = 100;
    job.stage = "Reference analysis complete";
    job.status = "complete";
    job.updatedAt = Date.now();
  } catch (e: any) {
    job.status = "failed";
    job.stage = "Reference analysis failed";
    job.error = e?.message ?? "Reference analysis failed.";
    job.updatedAt = Date.now();
  } finally {
    active = false;
    void pump();
  }
}

export function startReferenceAnalysisJob(path: string) {
  cleanup();
  const job: ReferenceJob = {
    id: randomUUID(),
    status: "queued",
    progress: 2,
    stage: "Queued for local analysis…",
    path,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  void pump();
  return job;
}

export function getReferenceJob(id: string) {
  cleanup();
  return jobs.get(id) ?? null;
}
