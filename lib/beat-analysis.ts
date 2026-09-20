import { guess } from "web-audio-beat-detector";
import { BeatInfo, MusicProfile } from "@/types";
import { buildBeatLockedGrid } from "@/lib/beat-grid";

function analyzeMusicProfile(section: AudioBuffer, bpm: number): MusicProfile {
  const channel = section.getChannelData(0);
  const sampleRate = section.sampleRate;
  const window = Math.max(1, Math.floor(sampleRate * 0.05));
  const rmsValues: number[] = [];
  const zcrValues: number[] = [];
  let spectralProxyTotal = 0;
  let spectralCount = 0;

  for (let start = 0; start < channel.length; start += window) {
    const end = Math.min(channel.length, start + window);
    if (end <= start) continue;
    let sumSq = 0;
    let crossings = 0;
    let previous = channel[start];
    for (let i = start; i < end; i++) {
      const sample = channel[i];
      sumSq += sample * sample;
      if ((sample >= 0) !== (previous >= 0)) crossings += 1;
      previous = sample;
    }
    const count = end - start;
    const rms = Math.sqrt(sumSq / count);
    rmsValues.push(rms);
    zcrValues.push(crossings / count);

    // A cheap brightness proxy: zero-crossing rate. It is deliberately named
    // as a proxy because it is not equivalent to a real spectral centroid.
    spectralProxyTotal += crossings / count;
    spectralCount += 1;
  }

  const mean = rmsValues.length ? rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length : 0;
  const sortedRms = [...rmsValues].sort((a, b) => a - b);
  const p90 = sortedRms.length ? sortedRms[Math.floor((sortedRms.length - 1) * 0.90)] : 0;
  const peak = Math.max(...rmsValues, 0);
  const variance = rmsValues.length
    ? rmsValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rmsValues.length
    : 0;
  const std = Math.sqrt(variance);

  // Absolute RMS differs dramatically between mastered tracks. Use a
  // section-normalized loudness ratio plus tempo and dynamics instead.
  const loudnessRatio = peak > 0 ? clamp01((0.65 * mean + 0.35 * p90) / peak) : 0;
  const tempoEnergy = clamp01((bpm - 85) / 80);
  const energy = clamp01((loudnessRatio * 0.52) + (tempoEnergy * 0.38) + (clamp01(std * 10) * 0.10));
  const dynamics = clamp01((std / Math.max(mean, 0.00001)) * 0.35 + ((peak - mean) / Math.max(peak, 0.00001)) * 0.65);
  const brightness = clamp01(spectralCount ? (spectralProxyTotal / spectralCount) * 8 : 0);

  const descriptors = new Set<string>();
  if (bpm >= 145 || energy >= 0.62) descriptors.add("energetic");
  else if (bpm <= 95 && energy <= 0.42) descriptors.add("calm");
  else descriptors.add("mid-energy");
  if (dynamics >= 0.5) descriptors.add("dynamic");
  if (brightness >= 0.55) descriptors.add("bright");
  else if (brightness <= 0.28) descriptors.add("dark/atmospheric");
  if (energy >= 0.72 && dynamics >= 0.5) descriptors.add("high-impact");
  if (bpm >= 120 && dynamics >= 0.35) descriptors.add("driving");
  if (bpm <= 105 && energy <= 0.48 && dynamics <= 0.35) descriptors.add("cinematic/slow");

  return { energy, dynamics, brightness, descriptors: Array.from(descriptors) };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export async function analyzeSong(url: string, windowStart: number, windowEnd: number, clipsPerBeat: 1 | 2 = 1): Promise<BeatInfo> {
  if (!(windowEnd > windowStart)) throw new Error("Song section end must be after its start.");

  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not download the selected song.");
  const arrayBuffer = await res.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const start = Math.max(0, Math.min(windowStart, audioBuffer.duration));
    const end = Math.max(start, Math.min(windowEnd, audioBuffer.duration));
    if (end - start < 0.25) throw new Error("Select at least 0.25 seconds of audio.");

    // Decode only the selected section for deterministic beat analysis.
    const sampleRate = audioBuffer.sampleRate;
    const frameStart = Math.floor(start * sampleRate);
    const frameEnd = Math.floor(end * sampleRate);
    const frames = Math.max(1, frameEnd - frameStart);
    const section = ctx.createBuffer(audioBuffer.numberOfChannels, frames, sampleRate);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      section.copyToChannel(audioBuffer.getChannelData(ch).subarray(frameStart, frameEnd), ch);
    }

    const { bpm } = await guess(section);
    const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;

    // Lightweight, dependency-free audio descriptors. These are intentionally
    // descriptive signals rather than claims of genre/emotion recognition.
    // They give the sequencing LLM enough information to distinguish calmer,
    // more dynamic, darker/brighter material without pretending we have a
    // full music-understanding model in the browser.
    const profile = analyzeMusicProfile(section, safeBpm);
    // The AI/render timeline is locked to BPM spacing rather than transient offset.
    // That guarantees one clip per beat by default and two clips per beat in 2x mode.
    const grid = buildBeatLockedGrid(section.duration, safeBpm, clipsPerBeat);
    const cuts = grid.cuts;
    const segmentDurations = grid.segmentDurations;
    const beatTimestamps = grid.cuts;

    return {
      bpm: Math.round(safeBpm * 10) / 10,
      beatTimestamps,
      cutTimestamps: cuts.slice(0, segmentDurations.length),
      windowStart: Number(start.toFixed(3)),
      windowEnd: Number(end.toFixed(3)),
      numCuts: segmentDurations.length,
      duration: Number(section.duration.toFixed(3)),
      segmentDurations,
      clipsPerBeat,
      musicProfile: profile,
    };
  } finally {
    await ctx.close();
  }
}
