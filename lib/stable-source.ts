import "server-only";
import { spawn } from "node:child_process";

/**
 * FFmpeg-side shot selection.
 *
 * Groq decides WHICH video. This module decides WHICH PART of it, and guarantees the
 * returned window lives inside ONE continuous shot (never straddles a detected cut).
 *
 * Pipeline:
 *   1. Detect real scene boundaries with FFmpeg's scene score (full decode, small frames, parsed line by line).
 *   2. Turn boundaries into continuous shots.
 *   3. Keep only shots with duration >= target.
 *   4. Search order: shot containing the MIDDLE of the video -> toward the END -> wrap around -> BEGINNING.
 *   5. Extract exactly `target` seconds from inside the chosen shot (margin from both cuts when there is slack).
 *   6. If no shot is long enough: return the longest single shot (shorter than target) and say so.
 *      The renderer then holds its last frame. Shots are NEVER combined.
 *   7. If detection itself fails, say so (status "unverified") instead of pretending.
 */

export type ShotStatus = "ok" | "short-shot" | "clip-too-short" | "unverified";

export interface ShotSelection {
  start: number;
  end: number;
  shotStart: number;
  shotEnd: number;
  shotCount: number;
  status: ShotStatus;
  note?: string;
}

export interface Shot { start: number; end: number; duration: number }
export interface ShotMap { duration: number; cuts: number[]; shots: Shot[]; verified: boolean }

// FFmpeg's scene score is a visual-change score, not AI vision. 0.20 catches ordinary hard cuts.
const SCENE_THRESHOLD = Number(process.env.VEYNLOR_SCENE_THRESHOLD ?? 0.2);
const ANALYSIS_TIMEOUT_MS = 60_000;
const MAX_MARGIN = 0.08;   // ~2 frames at 30fps kept between the window and any detected cut, when the shot has slack
const EPS = 0.001;

// Bump when selection behavior changes. Exposed at /api/version so you can prove which build is live.
export const SELECTION_VERSION = "2026-09-20-v3-one-shot-rule";

const mapCache = new Map<string, ShotMap>();
const MAX_CACHE = 500;
function remember(key: string, value: ShotMap) {
  mapCache.set(key, value);
  if (mapCache.size > MAX_CACHE) {
    const oldest = mapCache.keys().next().value;
    if (oldest !== undefined) mapCache.delete(oldest);
  }
}

function runSceneDetection(url: string): Promise<{ cuts: number[]; duration: number | null }> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "info", "-nostats", "-threads", "1",
      "-i", url,
      "-vf", `scale=320:320:force_original_aspect_ratio=decrease:flags=fast_bilinear,select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
      "-an", "-sn", "-dn", "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    const cuts = new Set<number>();
    let duration: number | null = null;
    let tail = "";
    let lastErrors = "";
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(() => reject(new Error(`Scene detection timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s.`))); }, ANALYSIS_TIMEOUT_MS);

    // Parsed incrementally: keeping only the last N KB of stderr silently dropped the EARLY cuts of busy clips.
    const consume = (line: string) => {
      if (duration === null) {
        const d = line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (d) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
      }
      const m = line.match(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/);
      if (m && /showinfo/.test(line)) { const t = Number(m[1]); if (Number.isFinite(t) && t > 0.02) cuts.add(Number(t.toFixed(3))); }
      if (/error|invalid|failed|no such file|403|404/i.test(line)) lastErrors = (lastErrors + line + "\n").slice(-1500);
    };
    child.stderr.on("data", (chunk: Buffer) => {
      tail += chunk.toString();
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() ?? "";
      for (const line of lines) consume(line);
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      if (tail) consume(tail);
      if (code !== 0) return finish(() => reject(new Error(`Scene detection failed (exit ${code}). ${lastErrors}`)));
      finish(() => resolve({ cuts: Array.from(cuts).sort((a, b) => a - b), duration }));
    });
  });
}

export function buildShots(duration: number, cuts: number[]): Shot[] {
  // Keep EVERY real cut (only exact duplicates are removed). Tiny slivers between two cuts are simply not
  // returned as shots, so they can never be selected -- but they also can never hide a cut inside a neighbour.
  const boundaries = [0, ...cuts.filter((t) => t > 0.02 && t < duration - 0.02), duration]
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.0005);
  const shots: Shot[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (end - start > 0.02) shots.push({ start, end, duration: end - start });
  }
  return shots;
}

/**
 * Pure selection logic (no I/O), exported so it can be unit-tested.
 * Never returns a window that spans two shots.
 */
export function pickWindow(map: ShotMap, target: number): ShotSelection {
  const duration = map.duration;
  const shots = map.shots.length ? map.shots : buildShots(duration, []);
  const mid = duration / 2;

  if (duration + 0.02 < target) {
    return { start: 0, end: Number(duration.toFixed(3)), shotStart: 0, shotEnd: Number(duration.toFixed(3)), shotCount: shots.length, status: "clip-too-short", note: `Source is ${duration.toFixed(2)}s, shorter than the ${target.toFixed(2)}s slot.` };
  }

  // Rotation: start at the shot that contains the middle of the video, walk toward the end, then wrap to the beginning.
  let startIndex = shots.findIndex((s) => s.start <= mid && mid < s.end);
  if (startIndex < 0) startIndex = Math.max(0, shots.findIndex((s) => s.start >= mid));
  const order = shots.map((_, k) => shots[(startIndex + k) % shots.length]);
  const chosenCandidates = order.filter((s) => s.duration + EPS >= target);

  const place = (shot: Shot, length: number, anchorMid: boolean) => {
    const slack = Math.max(0, shot.duration - length);
    const margin = Math.min(MAX_MARGIN, slack / 2);      // margin only when the shot has room for it
    const lo = shot.start + margin;
    const hi = shot.end - margin - length;
    const desired = anchorMid && shot.start <= mid && mid < shot.end ? mid - length / 2 : shot.start + slack / 2;
    const start = Math.min(Math.max(desired, lo), Math.max(lo, hi));
    const rawStart = Math.max(shot.start, start);
    const rawEnd = Math.min(shot.end, start + length);
    // Round INWARD (start up, end down) rather than to nearest millisecond. Rounding to nearest can push a
    // boundary a fraction of a millisecond PAST the real detected cut (debugging item #10: short targets landing
    // exactly on a shot's edge were the case most likely to round outward and technically straddle the cut).
    // Rounding inward instead means a window can shrink by at most ~1ms -- far below one video frame -- but can
    // never grow past a shot's true edge.
    const roundedStart = Math.ceil(rawStart * 1000) / 1000;
    const roundedEnd = Math.max(roundedStart, Math.floor(rawEnd * 1000) / 1000);
    return { start: roundedStart, end: roundedEnd };
  };

  const validShots = shots.filter((s) => s.duration + EPS >= target);
  const debugBase = `target=${target.toFixed(3)} duration=${duration.toFixed(3)} verified=${map.verified} cuts=${JSON.stringify(map.cuts.map((c) => Number(c.toFixed(3))))} shots=${JSON.stringify(shots.map((s) => [Number(s.start.toFixed(3)), Number(s.end.toFixed(3))]))} validShots=${JSON.stringify(validShots.map((s) => [Number(s.start.toFixed(3)), Number(s.end.toFixed(3))]))}`;

  const crossesCut = (w: { start: number; end: number }) => map.cuts.some((c) => c > w.start + 0.0005 && c < w.end - 0.0005);
  // Final safety net: only accept a window that provably contains no detected cut.
  let chosen: Shot | undefined;
  for (const candidate of chosenCandidates) {
    if (!crossesCut(place(candidate, target, true))) { chosen = candidate; break; }
  }

  if (chosen) {
    const w = place(chosen, target, true);
    // IMPORTANT: an unverified map is built as ONE fake shot spanning the whole clip (no real cut data), so
    // "chosen" here is never something we can vouch for as cut-free. Callers (sequence-pipeline) must treat
    // "unverified" as needing a swap to a clip whose cuts we actually verified -- never render this blind.
    console.log(`[shots:pick] ${debugBase} chosen=${JSON.stringify([Number(chosen.start.toFixed(3)), Number(chosen.end.toFixed(3))])} sourceStart=${w.start} sourceEnd=${w.end} status=${map.verified ? "ok" : "unverified"}`);
    return {
      ...w, shotStart: Number(chosen.start.toFixed(3)), shotEnd: Number(chosen.end.toFixed(3)), shotCount: shots.length,
      status: map.verified ? "ok" : "unverified",
      note: map.verified ? undefined : "Scene detection was unavailable, so this window could not be checked against cuts.",
    };
  }

  // No single shot is long enough. Take the longest continuous shot as-is; NEVER stitch shots together.
  const longest = order.reduce((best, s) => (s.duration > best.duration + EPS ? s : best), order[0]);
  const w = place(longest, Math.min(longest.duration, target), true);
  console.log(`[shots:pick] ${debugBase} chosen=none longest=${JSON.stringify([Number(longest.start.toFixed(3)), Number(longest.end.toFixed(3))])} sourceStart=${w.start} sourceEnd=${w.end} status=${map.verified ? "short-shot" : "unverified"}`);
  if (!map.verified) {
    // Detection failed entirely: we have zero real cut data, not even "one shot too short". Same rule as above --
    // report "unverified" (never "short-shot") so the pipeline knows this section is unchecked, not confirmed short.
    return {
      ...w, shotStart: Number(longest.start.toFixed(3)), shotEnd: Number(longest.end.toFixed(3)), shotCount: shots.length, status: "unverified",
      note: "Scene detection was unavailable, so this window could not be checked against cuts.",
    };
  }
  return {
    ...w, shotStart: Number(longest.start.toFixed(3)), shotEnd: Number(longest.end.toFixed(3)), shotCount: shots.length, status: "short-shot",
    note: `Longest cut-free shot is ${longest.duration.toFixed(2)}s but the slot needs ${target.toFixed(2)}s. Using that single shot; its last frame is held for the remainder.`,
  };
}

export async function getShotMap(cacheKey: string, url: string, declaredDuration?: number | null): Promise<ShotMap> {
  const cached = mapCache.get(cacheKey);
  if (cached) return cached;

  let map: ShotMap | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && !map; attempt++) {
    try {
      const { cuts, duration: probed } = await runSceneDetection(url);
      const duration = probed && probed > 0 ? probed : Number(declaredDuration ?? 0);
      if (!(duration > 0)) throw new Error("Could not determine the video duration.");
      map = { duration, cuts, shots: buildShots(duration, cuts), verified: true };
      console.log(`[shots] ${cacheKey}: ${duration.toFixed(2)}s, ${cuts.length} cut(s) -> ${map.shots.length} shot(s)`);
    } catch (error) {
      lastError = (error as Error).message;
      if (/timed out/i.test(lastError)) break;   // a timeout will just time out again; fail fast so the pipeline can swap clips
    }
  }
  if (!map) {
    console.warn(`[shots] scene detection FAILED for ${cacheKey}: ${lastError}`);
    const duration = Number(declaredDuration ?? 0);
    map = { duration, cuts: [], shots: duration > 0 ? buildShots(duration, []) : [], verified: false };
    // Do not cache failures: the next generation should try again.
    return map;
  }
  remember(cacheKey, map);
  return map;
}

/** Select an uninterrupted section of `target` seconds from the given source video. */
export async function selectShotWindow(opts: { cacheKey: string; url: string; target: number; sourceDuration?: number | null }): Promise<ShotSelection> {
  const target = Number(opts.target);
  const declared = Number(opts.sourceDuration ?? 0);
  if (!(target > 0)) return { start: 0, end: Math.max(0, declared), shotStart: 0, shotEnd: Math.max(0, declared), shotCount: 0, status: "ok" };
  const map = await getShotMap(opts.cacheKey, opts.url, declared);
  if (!(map.duration > 0)) return { start: 0, end: target, shotStart: 0, shotEnd: target, shotCount: 0, status: "unverified", note: "Video duration is unknown; section could not be verified." };
  return pickWindow(map, target);
}

/** Back-compat wrapper (older callers only need start/end). */
export async function findNoCutSection(url: string, target: number, sourceDuration?: number, cacheKey?: string) {
  const s = await selectShotWindow({ cacheKey: cacheKey ?? url, url, target, sourceDuration });
  return { start: s.start, end: s.end };
}
