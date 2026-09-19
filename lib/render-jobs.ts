import "server-only";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { supabaseServer } from "@/lib/supabase-server";
import { renderReel, RenderClip } from "@/lib/render";
import { TextOverlay } from "@/types";

type JobStatus = "queued" | "rendering" | "complete" | "failed";

export interface RenderJob {
  id: string;
  status: JobStatus;
  progress: number;
  stage: string;
  currentClip?: number;
  totalClips?: number;
  url?: string;
  path?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, RenderJob>();
const MAX_JOBS = 50;
const JOB_TTL = 60 * 60 * 1000;
let activeJobId: string | null = null;

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
  while (jobs.size > MAX_JOBS) {
    const first = jobs.keys().next().value;
    if (!first) break;
    jobs.delete(first);
  }
}

export function getRenderJob(id: string) {
  cleanupJobs();
  return jobs.get(id) ?? null;
}

async function uploadFileWithoutBuffer(bucket: string, path: string, localPath: string) {
  const stat = await fs.stat(localPath);
  const base = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Supabase server configuration is missing.");

  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const file = (await import("node:fs")).createReadStream(localPath);
  const response = await fetch(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, ({
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      apikey: key,
      "content-type": "video/mp4",
      "content-length": String(stat.size),
      "x-upsert": "false",
    },
    body: file,
    duplex: "half",
  } as any));
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Rendered MP4 upload failed (${response.status}). ${text.slice(0, 1000)}`);
  }
}

export function startRenderJob(args: {
  clips: RenderClip[];
  songUrl: string;
  songStart: number;
  songEnd: number;
  textOverlay?: TextOverlay;
}) {
  cleanupJobs();
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && (active.status === "queued" || active.status === "rendering")) {
      throw new Error("Another render is already running. Wait for it to finish before starting another.");
    }
  }

  const id = randomUUID();
  const job: RenderJob = {
    id,
    status: "queued",
      progress: 0,
    stage: "Queued",
    totalClips: args.clips.length,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  activeJobId = id;

  void (async () => {
    let output: string | null = null;
    try {
      job.status = "rendering";
      job.stage = "Starting low-memory FFmpeg render";
      output = await renderReel({ ...args, onProgress: (progress, stage, currentClip, totalClips) => {
        job.progress = progress;
        job.stage = stage;
        job.updatedAt = Date.now();
        job.currentClip = currentClip;
        job.totalClips = totalClips;
      }});

      const storagePath = `renders/${Date.now()}-${id}-veylnor-reel.mp4`;
      job.stage = "Uploading finished MP4";
      job.progress = 94;
      job.updatedAt = Date.now();
      await uploadFileWithoutBuffer("renders", storagePath, output);

      job.progress = 98;
      job.stage = "Creating secure MP4 link";
      job.updatedAt = Date.now();
      const signedOut = await supabaseServer.storage.from("renders").createSignedUrl(storagePath, 24 * 60 * 60);
      if (!signedOut.data?.signedUrl) throw new Error("Render uploaded but a download URL could not be created.");

      job.path = storagePath;
      job.url = signedOut.data.signedUrl;
      job.progress = 100;
      job.stage = "MP4 ready";
      job.status = "complete";
      job.updatedAt = Date.now();
    } catch (e: any) {
      job.error = e?.message ?? "FFmpeg render failed.";
      job.stage = "Render failed";
      job.status = "failed";
      job.updatedAt = Date.now();
    } finally {
      if (output) await fs.unlink(output).catch(() => {});
      if (activeJobId === id) activeJobId = null;
    }
  })();

  return job;
}
