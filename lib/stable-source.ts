import "server-only";
import { spawn } from "node:child_process";

export interface StableSourceSelection {
  start: number;
  end: number;
}

const sourceCache = new Map<string, StableSourceSelection>();
const cutCache = new Map<string, number[]>();
const MAX_CACHE = 200;
const SCENE_THRESHOLD = 0.30;
const ANALYSIS_TIMEOUT_MS = 10000;

function remember<K, V>(cache: Map<K, V>, key: K, value: V) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

function runSceneDetection(url: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "info", "-nostats",
      "-i", url,
      "-vf", `scale=320:180:force_original_aspect_ratio=decrease:flags=fast_bilinear,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      "-an", "-sn", "-dn", "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("Scene detection timed out.")));
    }, ANALYSIS_TIMEOUT_MS);

    child.stderr.on("data", d => {
      stderr = (stderr + d.toString()).slice(-25000);
    });
    child.on("error", err => finish(() => reject(err)));
    child.on("close", code => {
      if (code !== 0) {
        finish(() => reject(new Error(`Scene detection failed (${code}). ${stderr.slice(-1500)}`)));
        return;
      }
      const cuts: number[] = [];
      for (const match of stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)) {
        const t = Number(match[1]);
        if (Number.isFinite(t) && t > 0.02) cuts.push(t);
      }
      const unique = Array.from(new Set(cuts.map(t => Number(t.toFixed(3))))).sort((a, b) => a - b);
      finish(() => resolve(unique));
    });
  });
}

function pickFromShots(duration: number, target: number, cuts: number[]): StableSourceSelection | null {
  if (!(duration > 0) || !(target > 0)) return null;
  if (duration <= target + 0.02) return { start: 0, end: Number(duration.toFixed(3)) };

  const boundaries = [0, ...cuts.filter(t => t < duration - 0.02), duration]
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.02);

  const shots: Array<{ start: number; end: number; center: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start + 0.001 >= target) {
      shots.push({ start, end, center: (start + end) / 2 });
    }
  }
  if (!shots.length) return null;

  // Avoid cutting exactly on a detected boundary. A tiny interior guard prevents
  // the first frame of the next shot from leaking into the requested segment.
  // Prefer candidates that have enough room for the guard; only use exact-fit shots
  // as a fallback when no guarded candidate exists.
  const FRAME_GUARD = 1 / 30;
  const guardedShots = shots.filter(s => s.end - s.start >= target + 2 * FRAME_GUARD);
  const candidateShots = guardedShots.length ? guardedShots : shots;

  const middleStart = duration / 3;
  const middleEnd = duration * 2 / 3;
  const center = duration / 2;
  const rank = (a: { center: number }, b: { center: number }) =>
    Math.abs(a.center - center) - Math.abs(b.center - center);

  // Required priority: middle → last → first. Within a region, choose the shot
  // closest to the source video's center.
  const groups = [
    candidateShots.filter(s => s.center >= middleStart && s.center <= middleEnd).sort(rank),
    candidateShots.filter(s => s.center > middleEnd).sort(rank),
    candidateShots.filter(s => s.center < middleStart).sort(rank),
  ];

  for (const group of groups) {
    const shot = group[0];
    if (!shot) continue;
    const guard = guardedShots.length ? FRAME_GUARD : 0;
    const usableStart = shot.start + guard;
    const usableEnd = shot.end - guard;
    const slack = Math.max(0, usableEnd - usableStart - target);
    const start = usableStart + slack / 2;
    const end = start + target;
    return { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) };
  }
  return null;
}

/**
 * Choose exactly `target` seconds that never crosses an FFmpeg-detected scene cut.
 * Priority is the candidate nearest the source video's center, then the last third,
 * then the first third. Motion inside the shot is allowed; only shot boundaries matter.
 */
export async function findNoCutSection(url: string, target: number, sourceDuration?: number): Promise<StableSourceSelection> {
  const safeTarget = Number(target);
  const duration = Number(sourceDuration ?? 0);
  if (!(safeTarget > 0)) return { start: 0, end: Math.max(0, duration) };
  // If the source is genuinely shorter than requested, no no-cut segment can exist.
  // Otherwise always analyze cuts—even when the source is only slightly longer than the target.
  if (duration > 0 && duration + 0.02 < safeTarget) {
    return { start: 0, end: Number(duration.toFixed(3)) };
  }

  const key = `${url}|${safeTarget.toFixed(3)}|${duration.toFixed(3)}`;
  const cached = sourceCache.get(key);
  if (cached) return cached;

  let cuts = cutCache.get(url);
  if (!cuts) {
    try {
      cuts = await runSceneDetection(url);
      remember(cutCache, url, cuts);
    } catch {
      // Analysis failure must never break generation; caller gets a normal middle fallback.
      cuts = [];
      remember(cutCache, url, cuts);
    }
  }

  const selected = pickFromShots(duration, safeTarget, cuts) ?? {
    start: Number(Math.max(0, (duration - safeTarget) / 2).toFixed(3)),
    end: Number((Math.max(0, (duration - safeTarget) / 2) + safeTarget).toFixed(3)),
  };
  remember(sourceCache, key, selected);
  return selected;
}
