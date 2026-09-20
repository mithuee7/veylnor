const MIN_SEGMENT_SECONDS = 0.05;
const MAX_CUTS = 64;

function round3(value: number) {
  return Number(value.toFixed(3));
}

/**
 * Beat-locked reel grid. The selected song window starts at t=0, then clips
 * change exactly every beat (or every half-beat in 2x mode).
 *
 * This intentionally ignores the detector's first transient offset when
 * building the edit grid. BPM defines the spacing; the grid starts cleanly
 * at the beginning of the selected section, avoiding accidental 0.10–0.20s
 * opening clips caused by onset-detector offsets.
 */
export function buildBeatLockedGrid(duration: number, bpm: number, clipsPerBeat: 1 | 2 = 1) {
  const safeDuration = Math.max(0, Number.isFinite(duration) ? duration : 0);
  const safeBpm = Math.max(1, Number.isFinite(bpm) ? bpm : 120);
  const density = clipsPerBeat === 2 ? 2 : 1;
  const interval = 60 / safeBpm / density;

  if (!(safeDuration > 0)) return { cuts: [0], segmentDurations: [], interval };

  const cuts: number[] = [0];
  for (let t = interval; t < safeDuration - MIN_SEGMENT_SECONDS; t += interval) {
    if (cuts.length >= MAX_CUTS) break;
    cuts.push(round3(t));
  }

  // Avoid leaving a tiny tail that would look like a broken final frame. The
  // final segment simply absorbs the remainder of the selected audio section.
  const segmentDurations = cuts.map((start, index) => {
    const end = index + 1 < cuts.length ? cuts[index + 1] : safeDuration;
    return round3(Math.max(0, end - start));
  }).filter(value => value > MIN_SEGMENT_SECONDS);

  return {
    cuts: cuts.slice(0, segmentDurations.length),
    segmentDurations,
    interval,
  };
}

export function applyBeatRateToInfo(beatInfo: import("@/types").BeatInfo, clipsPerBeat: 1 | 2): import("@/types").BeatInfo {
  const grid = buildBeatLockedGrid(beatInfo.duration, beatInfo.bpm, clipsPerBeat);
  const beatTimestamps = grid.cuts;
  return {
    ...beatInfo,
    clipsPerBeat,
    beatTimestamps,
    cutTimestamps: grid.cuts,
    numCuts: grid.segmentDurations.length,
    segmentDurations: grid.segmentDurations,
  };
}

export const BEAT_GRID_LIMITS = {
  minSegmentSeconds: MIN_SEGMENT_SECONDS,
  maxCuts: MAX_CUTS,
};
