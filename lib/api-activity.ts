import "server-only";
import { randomUUID } from "node:crypto";
import { getRenderJob } from "@/lib/render-jobs";

type ActivityStatus = "processing" | "complete" | "failed";

export interface ApiActivity {
  id: string;
  status: ActivityStatus;
  stage: string;
  progress: number;
  songId?: string;
  songFilename?: string;
  renderJobId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const activities = new Map<string, ApiActivity>();
const MAX_ACTIVITIES = 50;
const TTL = 24 * 60 * 60 * 1000;

function cleanup() {
  const cutoff = Date.now() - TTL;
  for (const [id, item] of activities) if (item.createdAt < cutoff) activities.delete(id);
  while (activities.size > MAX_ACTIVITIES) {
    const first = activities.keys().next().value;
    if (!first) break;
    activities.delete(first);
  }
}

export function createApiActivity(songId?: string) {
  cleanup();
  const id = randomUUID();
  const item: ApiActivity = {
    id,
    status: "processing",
    stage: "Request received",
    progress: 2,
    songId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  activities.set(id, item);
  return item;
}

export function updateApiActivity(id: string, patch: Partial<ApiActivity>) {
  const item = activities.get(id);
  if (!item) return null;
  Object.assign(item, patch, { updatedAt: Date.now() });
  return item;
}

export function getApiActivity(id: string) {
  cleanup();
  return activities.get(id) ?? null;
}

export function listApiActivities() {
  cleanup();
  return Array.from(activities.values())
    .map(item => {
      if (!item.renderJobId) return item;
      const render = getRenderJob(item.renderJobId);
      if (!render) return item;
      return {
        ...item,
        status: render.status === "complete" ? "complete" : render.status === "failed" ? "failed" : "processing",
        stage: render.stage,
        progress: Math.max(item.progress, render.progress),
        error: render.error ?? item.error,
      } satisfies ApiActivity;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
