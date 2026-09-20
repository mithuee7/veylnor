import "server-only";
import { spawn } from "node:child_process";
import { BeatInfo, MusicProfile } from "@/types";
import { buildBeatLockedGrid } from "@/lib/beat-grid";

type TempoBucket = { peaks: number[]; score: number; tempo: number };

type TempoSettings = { minTempo?: number; maxTempo?: number };

function getMaximumValue(channelData: Float32Array) {
  let maximum = 0;
  for (let i = 0; i < channelData.length; i += 1) maximum = Math.max(maximum, channelData[i]);
  return maximum;
}

function getPeaksAtThreshold(channelData: Float32Array, threshold: number, sampleRate: number) {
  const peaks: number[] = [];
  let lastValueWasAboveThreshold = false;
  for (let i = 0; i < channelData.length; i += 1) {
    if (channelData[i] > threshold) {
      lastValueWasAboveThreshold = true;
    } else if (lastValueWasAboveThreshold) {
      lastValueWasAboveThreshold = false;
      peaks.push(i - 1);
      i += sampleRate / 4 - 1;
    }
  }
  if (lastValueWasAboveThreshold) peaks.push(channelData.length - 1);
  return peaks;
}

function countIntervalsBetweenNearbyPeaks(peaks: number[]) {
  const intervalBuckets: { interval: number; peaks: number[] }[] = [];
  peaks.forEach((peak, index) => {
    const length = Math.min(peaks.length - index, 10);
    for (let i = 1; i < length; i += 1) {
      const interval = peaks[index + i] - peak;
      const found = intervalBuckets.find(bucket => bucket.interval === interval);
      if (found) found.peaks.push(peak);
      else intervalBuckets.push({ interval, peaks: [peak] });
    }
  });
  return intervalBuckets;
}

function groupNeighborsByTempo(intervalBuckets: { interval: number; peaks: number[] }[], sampleRate: number, settings: TempoSettings = {}) {
  const maxTempo = Math.max(0, settings.maxTempo ?? 180);
  const minTempo = Math.max(0, settings.minTempo ?? 90);
  const tempoBuckets: TempoBucket[] = [];

  intervalBuckets.forEach(intervalBucket => {
    let theoreticalTempo = 60 / (intervalBucket.interval / sampleRate);
    while (theoreticalTempo < minTempo) theoreticalTempo *= 2;
    while (theoreticalTempo > maxTempo) theoreticalTempo /= 2;
    if (theoreticalTempo < minTempo) return;

    let foundTempo = false;
    let score = intervalBucket.peaks.length;
    tempoBuckets.forEach(bucket => {
      if (bucket.tempo === theoreticalTempo) {
        bucket.score += intervalBucket.peaks.length;
        bucket.peaks = [...bucket.peaks, ...intervalBucket.peaks];
        foundTempo = true;
      }
      if (bucket.tempo > theoreticalTempo - 0.5 && bucket.tempo < theoreticalTempo + 0.5) {
        const tempoDifference = Math.abs(bucket.tempo - theoreticalTempo) * 2;
        score += (1 - tempoDifference) * bucket.peaks.length;
        bucket.score += (1 - tempoDifference) * intervalBucket.peaks.length;
      }
    });
    if (!foundTempo) tempoBuckets.push({ peaks: intervalBucket.peaks, score, tempo: theoreticalTempo });
  });

  return tempoBuckets;
}

function guessBpm(channelData: Float32Array, sampleRate: number) {
  const maximumValue = getMaximumValue(channelData);
  const minimumThreshold = maximumValue * 0.3;
  let peaks: number[] = [];
  let threshold = maximumValue - maximumValue * 0.05;

  if (maximumValue > 0.25) {
    while (peaks.length < 30 && threshold >= minimumThreshold) {
      peaks = getPeaksAtThreshold(channelData, threshold, sampleRate);
      threshold -= maximumValue * 0.05;
    }
  }

  const tempoBuckets = groupNeighborsByTempo(countIntervalsBetweenNearbyPeaks(peaks), sampleRate, { minTempo: 60, maxTempo: 240 });
  tempoBuckets.sort((a, b) => b.score - a.score);
  if (!tempoBuckets.length) throw new Error("Could not detect BPM from the selected song section.");

  const best = tempoBuckets[0];
  const bpm = Math.round(best.tempo);
  const secondsPerBeat = 60 / bpm;
  best.peaks.sort((a, b) => a - b);
  let offset = best.peaks[0] / sampleRate;
  while (offset > secondsPerBeat) offset -= secondsPerBeat;
  return { bpm, offset };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function analyzeMusicProfile(channel: Float32Array, bpm: number): MusicProfile {
  const sampleRate = 44100;
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
    for (let i = start; i < end; i += 1) {
      const sample = channel[i];
      sumSq += sample * sample;
      if ((sample >= 0) !== (previous >= 0)) crossings += 1;
      previous = sample;
    }
    const count = end - start;
    const rms = Math.sqrt(sumSq / count);
    rmsValues.push(rms);
    zcrValues.push(crossings / count);
    spectralProxyTotal += crossings / count;
    spectralCount += 1;
  }

  const mean = rmsValues.length ? rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length : 0;
  const sortedRms = [...rmsValues].sort((a, b) => a - b);
  const p90 = sortedRms.length ? sortedRms[Math.floor((sortedRms.length - 1) * 0.9)] : 0;
  const peak = Math.max(...rmsValues, 0);
  const variance = rmsValues.length ? rmsValues.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rmsValues.length : 0;
  const std = Math.sqrt(variance);
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

async function decodeSection(url: string, start: number, duration: number) {
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(Math.max(0, start)),
    "-t", String(Math.max(0.25, duration)),
    "-i", url,
    "-vn", "-ac", "1", "-ar", "44100", "-f", "f32le", "pipe:1",
  ];

  return await new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`FFmpeg could not decode the song for BPM detection. ${Buffer.concat(errors).toString("utf8").slice(0, 500)}`));
        return;
      }
      const raw = Buffer.concat(chunks);
      const usable = raw.length - (raw.length % 4);
      if (usable < 4) {
        reject(new Error("The selected song section contains no decodable audio."));
        return;
      }
      const values = new Float32Array(usable / 4);
      for (let i = 0; i < values.length; i += 1) values[i] = raw.readFloatLE(i * 4);
      resolve(values);
    });
  });
}

export async function analyzeSongServer(url: string, windowStart: number, windowEnd: number, clipsPerBeat: 1 | 2 = 1): Promise<BeatInfo> {
  if (!(windowEnd > windowStart)) throw new Error("Song section end must be after its start.");
  const duration = Number((windowEnd - windowStart).toFixed(3));
  if (duration < 0.25) throw new Error("Select at least 0.25 seconds of audio.");

  const channel = await decodeSection(url, windowStart, duration);
  const { bpm } = guessBpm(channel, 44100);
  const profile = analyzeMusicProfile(channel, bpm);
  const grid = buildBeatLockedGrid(duration, bpm, clipsPerBeat);

  return {
    bpm,
    beatTimestamps: grid.cuts,
    cutTimestamps: grid.cuts,
    windowStart: Number(windowStart.toFixed(3)),
    windowEnd: Number(windowEnd.toFixed(3)),
    numCuts: grid.segmentDurations.length,
    duration,
    segmentDurations: grid.segmentDurations,
    clipsPerBeat,
    musicProfile: profile,
  };
}
