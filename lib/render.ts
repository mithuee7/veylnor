import "server-only";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TextOverlay } from "@/types";

export interface RenderClip { url: string; start: number; end: number; targetDuration?: number; sourceDuration?: number; }
export interface RenderArgs { clips: RenderClip[]; songUrl: string; songStart: number; songEnd: number; textOverlay?: TextOverlay; onProgress?: (progress: number, stage: string, currentClip?: number, totalClips?: number) => void; }

type ProgressFn = (fraction: number) => void;

// Render is deliberately conservative because the target Render service has only 512 MB RAM.
// Keep FFmpeg well below the container limit so Node + Next.js + Supabase clients still have headroom.
const FFMPEG_RSS_LIMIT_MB = 300;
const FFMPEG_RSS_LIMIT_BYTES = FFMPEG_RSS_LIMIT_MB * 1024 * 1024;

async function getRss(pid: number): Promise<number> {
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch { return 0; }
}

function run(args: string[], durationSeconds?: number, onProgress?: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let progressBuffer = "";
    let settled = false;
    let memoryTimer: NodeJS.Timeout | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (memoryTimer) clearInterval(memoryTimer);
      fn();
    };

    memoryTimer = setInterval(async () => {
      if (settled || child.killed || !child.pid) return;
      const rss = await getRss(child.pid);
      if (rss > FFMPEG_RSS_LIMIT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`FFmpeg stopped safely at ${Math.round(rss / 1024 / 1024)} MB RAM. The source video is too memory-heavy for the 512 MB Render instance.`)));
      }
    }, 250);

    child.stderr.on("data", d => {
      const text = d.toString();
      stderr = (stderr + text).slice(-5000);
      if (durationSeconds && onProgress) {
        progressBuffer += text;
        const lines = progressBuffer.split(/\r?\n/);
        progressBuffer = lines.pop() || "";
        for (const line of lines) {
          const m = line.match(/^out_time_ms=(\d+)/);
          if (m) onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1_000_000 / durationSeconds)));
        }
      }
    });
    child.on("error", err => finish(() => reject(err)));
    child.on("close", code => finish(() => code === 0 ? (onProgress?.(1), resolve()) : reject(new Error(`FFmpeg failed (${code}). ${stderr.slice(-3000)}`))));
  });
}


async function renderSegment(c: RenderClip, out: string, width: number, height: number, onProgress?: ProgressFn) {
  const dur = c.end - c.start;
  if (!(dur > 0.02)) throw new Error("A clip has an invalid source section.");
  // When no single cut-free shot was long enough for the slot, the section is ONE shorter shot.
  // Hold its last frame for the remainder so the beat grid stays exact. Shots are never stitched together.
  const slot = Number(c.targetDuration ?? dur);
  const hold = Math.max(0, slot - dur);
  const holdFilter = hold > 0.03 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : "";

  // Important: exactly ONE source is decoded at a time. No filter_complex with all clips.
  await run([
    "-y", "-hide_banner", "-loglevel", "error", "-nostats",
    "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1",
    "-ss", String(c.start), "-t", String(dur), "-i", c.url,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=fast_bilinear,crop=${width}:${height},setsar=1,fps=30,format=yuv420p${holdFilter}`,
    "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-x264-params", "threads=1:lookahead_threads=1:rc-lookahead=0:ref=1:bframes=0",
    "-crf", width < 1000 ? "32" : "24", "-pix_fmt", "yuv420p", "-progress", "pipe:2", out
  ], dur + hold, onProgress);
}

function escapeDrawtextPath(filePath: string) {
  return filePath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function buildTextFilter(textFile: string, textOverlay?: TextOverlay) {
  if (!textOverlay?.enabled || !textOverlay.text.trim()) return null;
  const size = Math.max(40, Math.min(112, Number(textOverlay.size) || 64));
  const textfile = escapeDrawtextPath(textFile);

  if (textOverlay.font === "EB Garamond") {
    const fontFile = escapeDrawtextPath(path.join(process.cwd(), "public", "fonts", "EBGaramond-Regular.ttf"));
    return `drawtext=fontfile='${fontFile}':textfile='${textfile}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2:fix_bounds=1`;
  }

  const fonts: Record<string, string> = {
    "Inter": "Inter",
    "Noto Sans": "Noto Sans",
    "DejaVu Sans": "DejaVu Sans",
  };
  const font = fonts[textOverlay.font] ?? "DejaVu Sans";
  return `drawtext=font='${font}':textfile='${textfile}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2:fix_bounds=1`;
}

export async function renderReel({ clips, songUrl, songStart, songEnd, textOverlay, onProgress }: RenderArgs): Promise<string> {
  if (!clips.length) throw new Error("No clips supplied.");
  if (!(songEnd > songStart) || songStart < 0) throw new Error("Invalid song section.");

  const id = randomUUID();
  const dir = `/tmp/veylnor-${id}`;
  const out = `${dir}/final.mp4`;
  await fs.mkdir(dir, { recursive: true });
  const width = 1080;
  const height = 1920;
  const totalClips = clips.length;
  const textFile = `${dir}/overlay.txt`;

  try {
    if (textOverlay?.enabled && textOverlay.text.trim()) {
      await fs.writeFile(textFile, textOverlay.text.trim().slice(0, 120), "utf8");
    }
    const segments: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const segment = `${dir}/segment-${i}.mp4`;
      const renderClip = clips[i];
      await renderSegment(renderClip, segment, width, height, fraction => {
        const overall = ((i + fraction) / totalClips) * 82;
        onProgress?.(Math.min(82, Math.round(overall)), `Encoding clip ${i + 1} of ${totalClips}`, i + 1, totalClips);
      });
      segments.push(segment);
      // Explicitly release the previous segment's source/decoder by only keeping the encoded file.
      onProgress?.(Math.round(((i + 1) / totalClips) * 82), `Clip ${i + 1} of ${totalClips} complete`, i + 1, totalClips);
    }

    onProgress?.(86, "Joining clips", totalClips, totalClips);
    const listFile = `${dir}/concat.txt`;
    const list = segments.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    await fs.writeFile(listFile, list, "utf8");
    const videoOnly = `${dir}/video.mp4`;
    await run(["-y", "-hide_banner", "-loglevel", "error", "-nostats", "-threads", "1", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", videoOnly]);

    const textFilter = buildTextFilter(textFile, textOverlay);
    let videoForMux = videoOnly;

    if (textFilter) {
      const textedVideo = `${dir}/video-texted.mp4`;
      onProgress?.(89, "Adding centered text", totalClips, totalClips);
      await run([
        "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-threads", "1",
        "-i", videoOnly,
        "-vf", textFilter,
        "-an",
        "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
        "-x264-params", "threads=1:lookahead_threads=1:rc-lookahead=0:ref=1:bframes=0",
        "-crf", "24", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", textedVideo,
      ]);
      videoForMux = textedVideo;
    }

    onProgress?.(94, textFilter ? "Adding selected audio" : "Adding selected audio", totalClips, totalClips);
    await run([
      "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-threads", "1",
      "-i", videoForMux, "-ss", String(songStart), "-t", String(songEnd - songStart), "-i", songUrl,
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "128k",
      "-shortest", "-movflags", "+faststart", out
    ]);
    onProgress?.(100, "MP4 ready", totalClips, totalClips);
    return out;
  } finally {
    const entries = await fs.readdir(dir).catch(() => []);
    await Promise.all(entries.filter(name => name !== "final.mp4").map(name => fs.unlink(`${dir}/${name}`).catch(() => {})));
  }
}
