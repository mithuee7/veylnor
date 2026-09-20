import "server-only";
import { spawn } from "node:child_process";
import { ReferenceAnalysis, ReferenceBeatSync, ReferenceShotAnalysis } from "@/types";

type CommandResult = { stdout: string; stderr: string; code: number };
type ProgressCallback = (progress: number, stage: string) => void;

function run(args: string[], options?: { maxBufferBytes?: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ffmpegPath, args);
    let stdout = "";
    let stderr = "";
    const maxBuffer = options?.maxBufferBytes ?? 64 * 1024 * 1024;
    child.stdout.on("data", d => {
      stdout += d.toString();
      if (Buffer.byteLength(stdout) > maxBuffer) child.kill("SIGKILL");
    });
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", code => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

function runBuffer(args: string[], options?: { maxBufferBytes?: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ffmpegPath, args);
    const chunks: Buffer[] = [];
    let total = 0;
    const maxBuffer = options?.maxBufferBytes ?? 32 * 1024 * 1024;
    let stderr = "";
    child.stdout.on("data", d => {
      const chunk = Buffer.from(d);
      total += chunk.length;
      if (total > maxBuffer) {
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", d => stderr += d.toString());
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

function parseDuration(stderr: string): number {
  const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (!durationMatch) throw new Error("Could not read reference duration.");
  return Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)))];
}

async function extractPcm16Mono(url: string): Promise<Float32Array> {
  const pcm = await runBuffer([
    "-hide_banner", "-loglevel", "error", "-i", url,
    "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
  ], { maxBufferBytes: 64 * 1024 * 1024 });
  const sampleCount = Math.floor(pcm.length / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
  return samples;
}

/** Lightweight onset/transient detection for reference beat alignment. */
function detectReferenceBeats(samples: Float32Array, sampleRate = 16000): number[] {
  if (samples.length < sampleRate * 0.25) return [];
  const frameSize = 1024;
  const hop = 256;
  const scores: number[] = [];
  let previousRms = 0;
  let previousDiff = 0;

  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let sumSq = 0;
    let diffSum = 0;
    let prev = samples[start];
    for (let i = start; i < start + frameSize; i++) {
      const s = samples[i];
      sumSq += s * s;
      diffSum += Math.abs(s - prev);
      prev = s;
    }
    const rms = Math.sqrt(sumSq / frameSize);
    const diff = diffSum / frameSize;
    scores.push(Math.max(0, rms - previousRms) + Math.max(0, diff - previousDiff) * 0.45);
    previousRms = rms;
    previousDiff = diff;
  }

  const baseline = quantile(scores, 0.65);
  const peak = Math.max(...scores, 0);
  const threshold = Math.max(baseline * 1.25, peak * 0.28, 0.002);
  const peaks: Array<{ time: number; score: number }> = [];
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] < threshold || scores[i] < scores[i - 1] || scores[i] < scores[i + 1]) continue;
    peaks.push({ time: (i * hop + frameSize / 2) / sampleRate, score: scores[i] });
  }

  const selected: Array<{ time: number; score: number }> = [];
  for (const point of peaks.sort((a, b) => a.time - b.time)) {
    const last = selected.at(-1);
    if (!last || point.time - last.time >= 0.17) selected.push(point);
    else if (point.score > last.score) selected[selected.length - 1] = point;
  }
  return selected.map(x => Number(x.time.toFixed(3)));
}

function alignCutsToBeats(cutTimestamps: number[], beatTimestamps: number[]): ReferenceBeatSync[] {
  if (!beatTimestamps.length) return cutTimestamps.map(time => ({ cutTime: time, nearestBeat: null, offset: null, aligned: false }));
  return cutTimestamps.map(cutTime => {
    let nearest = beatTimestamps[0];
    for (const beat of beatTimestamps) if (Math.abs(beat - cutTime) < Math.abs(nearest - cutTime)) nearest = beat;
    const offset = Number((cutTime - nearest).toFixed(3));
    return { cutTime: Number(cutTime.toFixed(3)), nearestBeat: Number(nearest.toFixed(3)), offset, aligned: Math.abs(offset) <= 0.12 };
  });
}

function unique(values: string[]) {
  return Array.from(new Set(values.map(x => x.trim()).filter(Boolean)));
}

function majority(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

function longestAlternation(values: string[]): string[] {
  const compact: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (compact.at(-1) !== value) compact.push(value);
  }
  return compact.slice(0, 24);
}

interface RawFrameSet {
  buffer: Buffer;
  width: number;
  height: number;
  fps: number;
  count: number;
  bytesPerFrame: number;
}

const FRAME_WIDTH = 128;
const FRAME_HEIGHT = 72;
const FRAME_FPS = 6;
const MAX_ANALYSIS_SECONDS = 90;

async function extractRgbFrames(url: string, duration: number): Promise<RawFrameSet> {
  const seconds = Math.min(duration, MAX_ANALYSIS_SECONDS);
  const bytesPerFrame = FRAME_WIDTH * FRAME_HEIGHT * 3;
  const expectedFrames = Math.max(1, Math.ceil(seconds * FRAME_FPS));
  const maxBytes = Math.max(8 * 1024 * 1024, expectedFrames * bytesPerFrame + bytesPerFrame * 2);
  const buffer = await runBuffer([
    "-hide_banner", "-loglevel", "error", "-t", String(seconds), "-i", url,
    "-vf", `fps=${FRAME_FPS},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=increase,crop=${FRAME_WIDTH}:${FRAME_HEIGHT},format=rgb24`,
    "-f", "rawvideo", "pipe:1",
  ], { maxBufferBytes: Math.min(maxBytes, 128 * 1024 * 1024) });
  return {
    buffer,
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    fps: FRAME_FPS,
    count: Math.floor(buffer.length / bytesPerFrame),
    bytesPerFrame,
  };
}

interface FrameStats {
  brightness: number;
  saturation: number;
  contrast: number;
  edgeDensity: number;
  centerEdgeDensity: number;
  frame: Buffer;
}

function readFrame(set: RawFrameSet, index: number): Buffer | null {
  const clamped = Math.max(0, Math.min(set.count - 1, index));
  if (set.count <= 0) return null;
  const start = clamped * set.bytesPerFrame;
  return set.buffer.subarray(start, start + set.bytesPerFrame);
}

function statsForFrame(frame: Buffer, width: number, height: number): FrameStats {
  let brightnessSum = 0;
  let brightnessSq = 0;
  let saturationSum = 0;
  let edgeSum = 0;
  let edgeCount = 0;
  let centerEdgeSum = 0;
  let centerEdgeCount = 0;

  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 3;
    const r = frame[i];
    const g = frame[i + 1];
    const b = frame[i + 2];
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 3;
      const r = frame[i] / 255;
      const g = frame[i + 1] / 255;
      const b = frame[i + 2] / 255;
      const bright = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      brightnessSum += bright;
      brightnessSq += bright * bright;
      saturationSum += max > 0 ? (max - min) / max : 0;

      if (x + 2 < width) {
        const edge = Math.abs(bright - gray(x + 2, y));
        edgeSum += edge;
        edgeCount += 1;
        const inCenter = x > width * 0.25 && x < width * 0.75 && y > height * 0.25 && y < height * 0.75;
        if (inCenter) { centerEdgeSum += edge; centerEdgeCount += 1; }
      }
    }
  }

  const count = Math.max(1, Math.floor((width / 2) * (height / 2)));
  const mean = brightnessSum / count;
  const variance = Math.max(0, brightnessSq / count - mean * mean);
  return {
    brightness: mean,
    saturation: saturationSum / count,
    contrast: Math.sqrt(variance),
    edgeDensity: edgeCount ? edgeSum / edgeCount : 0,
    centerEdgeDensity: centerEdgeCount ? centerEdgeSum / centerEdgeCount : 0,
    frame,
  };
}

function frameDifference(a: Buffer | null, b: Buffer | null): number {
  if (!a || !b || a.length !== b.length) return 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 3) {
    const ar = a[i], ag = a[i + 1], ab = a[i + 2];
    const br = b[i], bg = b[i + 1], bb = b[i + 2];
    total += (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / (3 * 255);
    count += 1;
  }
  return count ? total / count : 0;
}

function analyzeShotLocally(shot: { index: number; start: number; end: number; duration: number }, frames: RawFrameSet): ReferenceShotAnalysis {
  const times = [0.25, 0.5, 0.75];
  const indices = times.map(ratio => Math.round((shot.start + shot.duration * ratio) * frames.fps));
  const samples = indices.map(index => readFrame(frames, index)).filter(Boolean) as Buffer[];
  const stats = samples.map(frame => statsForFrame(frame, frames.width, frames.height));
  const meanBrightness = stats.reduce((sum, item) => sum + item.brightness, 0) / Math.max(1, stats.length);
  const meanSaturation = stats.reduce((sum, item) => sum + item.saturation, 0) / Math.max(1, stats.length);
  const meanContrast = stats.reduce((sum, item) => sum + item.contrast, 0) / Math.max(1, stats.length);
  const meanEdge = stats.reduce((sum, item) => sum + item.edgeDensity, 0) / Math.max(1, stats.length);
  const meanCenterEdge = stats.reduce((sum, item) => sum + item.centerEdgeDensity, 0) / Math.max(1, stats.length);
  const changes: number[] = [];
  for (let i = 1; i < samples.length; i++) changes.push(frameDifference(samples[i - 1], samples[i]));
  const frameChange = changes.length ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
  const motionLevel = frameChange >= 0.12 ? "high" : frameChange >= 0.045 ? "medium" : "low";
  const composition = meanCenterEdge > meanEdge * 1.16 ? "center-weighted" : meanEdge > 0 && meanCenterEdge < meanEdge * 0.84 ? "edge-weighted" : "balanced";
  const cameraMovement = frameChange >= 0.045 ? "moving" : "static";
  const role = shot.index === 1 ? "hook" : shot.end >= (shot.start + shot.duration) && shot.start + shot.duration > 0 && shot.duration > 0 && shot.start + shot.duration >= 0 ? "standard" : "standard";
  const visualImpact = Math.max(1, Math.min(10, Math.round((frameChange * 38) + (meanContrast * 18) + (meanEdge * 20) + (meanSaturation * 4) + 1)));

  const tone = meanBrightness < 0.25 ? "dark" : meanBrightness > 0.68 ? "bright" : meanSaturation > 0.45 ? "saturated" : "neutral";
  const tags = [motionLevel === "high" ? "high-motion" : motionLevel === "medium" ? "moving" : "static", tone, composition];
  if (meanContrast > 0.22) tags.push("high-contrast");

  return {
    ...shot,
    primarySubject: "unknown",
    subjectTags: unique(tags),
    peoplePresent: null,
    composition,
    cameraMovement,
    movementDirection: "unknown",
    motionLevel,
    action: cameraMovement === "moving" ? "visual movement" : "mostly static visual",
    role,
    visualImpact,
    editingIntent: frameChange >= 0.08
      ? "A visually active shot that carries momentum between cuts."
      : meanContrast > 0.2
        ? "A high-contrast shot used to reset or emphasize the visual rhythm."
        : "A visually stable shot that supports pacing and contrast.",
    brightness: Number(meanBrightness.toFixed(3)),
    saturation: Number(meanSaturation.toFixed(3)),
    contrast: Number(meanContrast.toFixed(3)),
    edgeDensity: Number(meanEdge.toFixed(3)),
    frameChange: Number(frameChange.toFixed(3)),
    dominantTone: tone,
  };
}

function buildFingerprint(shots: ReferenceShotAnalysis[], beatSync: ReferenceBeatSync[]) {
  const hook = shots.slice(0, Math.min(4, shots.length));
  const ending = shots.slice(Math.max(0, shots.length - 4));
  const compositions = shots.map(s => s.composition).filter(Boolean);
  const motion = shots.map(s => s.motionLevel).filter(Boolean);
  const camera = shots.map(s => s.cameraMovement).filter(Boolean);
  const tones = shots.map(s => s.dominantTone ?? "").filter(Boolean);
  const alignedCount = beatSync.filter(x => x.aligned).length;
  const compositionVariety = unique(compositions).length / Math.max(1, Math.min(compositions.length, 4));

  let continuityMatches = 0;
  let continuityPairs = 0;
  for (let i = 1; i < shots.length; i++) {
    if (shots[i - 1].cameraMovement && shots[i].cameraMovement) {
      continuityPairs += 1;
      if (shots[i - 1].cameraMovement === shots[i].cameraMovement) continuityMatches += 1;
    }
  }

  return {
    hookStructure: {
      shotCount: hook.length,
      compositions: longestAlternation(hook.map(s => s.composition)),
      motion: longestAlternation(hook.map(s => s.motionLevel)),
      cameraMovement: longestAlternation(hook.map(s => s.cameraMovement)),
      durations: hook.map(s => s.duration),
    },
    subjectProgression: [],
    subjectMix: [],
    repetitionPatterns: {
      compositionSequence: compositions.slice(0, 32),
      motionSequence: motion.slice(0, 32),
      cameraSequence: camera.slice(0, 32),
      toneSequence: tones.slice(0, 32),
    },
    compositionPattern: {
      sequence: compositions.slice(0, 32),
      variety: Number(clamp01(compositionVariety).toFixed(2)),
      mostCommon: majority(compositions),
    },
    movementContinuity: {
      score: continuityPairs ? Number((continuityMatches / continuityPairs).toFixed(2)) : null,
      cameraMovement: camera.slice(0, 32),
    },
    endingPayoff: {
      shotCount: ending.length,
      compositions: longestAlternation(ending.map(s => s.composition)),
      motion: longestAlternation(ending.map(s => s.motionLevel)),
      visualImpact: ending.map(s => s.visualImpact),
      strongestShot: ending.reduce((best, shot) => !best || shot.visualImpact > best.visualImpact ? shot : best, null as ReferenceShotAnalysis | null)?.index ?? null,
    },
    beatSync: {
      alignedCutRatio: beatSync.length ? Number((alignedCount / beatSync.length).toFixed(2)) : null,
      cutOffsets: beatSync.map(x => x.offset),
    },
    styleFingerprint: {
      shotPacing: shots.length ? Number((shots.reduce((sum, shot) => sum + shot.duration, 0) / shots.length).toFixed(3)) : null,
      compositionVariety: Number(clamp01(compositionVariety).toFixed(2)),
      movementProfile: majority(motion),
      cameraProfile: majority(camera),
      toneProfile: majority(tones),
      hookDurations: hook.map(s => s.duration),
      endingDurations: ending.map(s => s.duration),
    },
  };
}

export async function analyzeReferenceVideo(url: string, onProgress: ProgressCallback = () => {}): Promise<ReferenceAnalysis> {
  onProgress(8, "Inspecting reference video…");
  const { stderr, code } = await run([
    "-hide_banner", "-i", url, "-vf", "select='gt(scene,0.32)',showinfo",
    "-an", "-f", "null", "-"
  ]);
  if (code !== 0) throw new Error(`Could not inspect reference reel: ${stderr.slice(-1200)}`);

  const duration = parseDuration(stderr);
  const cuts = Array.from(stderr.matchAll(/pts_time:([0-9.]+)/g))
    .map(m => Number(m[1]))
    .filter(Number.isFinite)
    .filter((t, i, a) => i === 0 || Math.abs(t - a[i - 1]) > 0.08);
  const boundaries = [0, ...cuts.filter(t => t > 0.05 && t < duration - 0.05), duration];
  const durations = boundaries.slice(0, -1).map((t, i) => Number((boundaries[i + 1] - t).toFixed(3)));
  const pattern = durations.map((d, i) => i === 0 ? "hook" : i === durations.length - 1 ? "payoff" : d < 0.65 ? "fast" : d > 1.8 ? "breather" : "standard");
  const shotsBase = durations.map((durationValue, index) => ({
    index: index + 1,
    start: boundaries[index],
    end: boundaries[index + 1],
    duration: durationValue,
  }));

  onProgress(22, `Found ${shotsBase.length} shots…`);
  let beatTimestamps: number[] = [];
  try {
    onProgress(30, "Analyzing reference audio…");
    const samples = await extractPcm16Mono(url);
    beatTimestamps = detectReferenceBeats(samples).filter(t => t > 0 && t < duration);
  } catch {
    beatTimestamps = [];
  }
  const beatSync = alignCutsToBeats([0, ...cuts], beatTimestamps);

  onProgress(40, "Extracting local visual frames…");
  const frames = await extractRgbFrames(url, duration);
  const shots = shotsBase.length
    ? shotsBase.map((shot, index) => {
        const analyzed = analyzeShotLocally(shot, frames);
        if (index % Math.max(1, Math.ceil(shotsBase.length / 8)) === 0) {
          onProgress(Math.min(84, 42 + Math.round((index / Math.max(1, shotsBase.length)) * 42)), `Analyzing visual shot ${index + 1} of ${shotsBase.length}…`);
        }
        return analyzed;
      })
    : [];
  if (shots.length) {
    shots[0] = { ...shots[0], role: "hook" };
    if (shots.length > 1) shots[shots.length - 1] = { ...shots[shots.length - 1], role: "payoff" };
  }

  onProgress(88, "Building reference fingerprint…");
  const fingerprint = buildFingerprint(shots, beatSync);
  onProgress(96, "Finalizing reference blueprint…");

  return {
    duration: Number(duration.toFixed(3)),
    cutTimestamps: cuts,
    cutCount: durations.length,
    durations,
    pattern,
    hookDuration: durations[0] ?? null,
    averageCutDuration: durations.length ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(3)) : duration,
    endingDuration: durations.at(-1) ?? null,
    beatTimestamps,
    beatSync,
    shots,
    fingerprint,
    visualShotCount: shots.length,
    visualShotTotal: shotsBase.length,
  };
}
