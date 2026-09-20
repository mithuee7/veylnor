export type Category = string;

// Kept as defaults only for backwards-compatible seed/migrations. The live AI taxonomy
// is loaded from public.clip_categories at runtime.
export const CATEGORIES: Category[] = [
  "women","cars","yachts","jets","jetski","money","mansions","lifestyle","travel","other",
];

export interface Clip {
  id: string;
  filename: string;
  category: Category;
  storage_path: string;
  duration: number | null;
  created_at: string;
}

export interface Song {
  id: string;
  filename: string;
  storage_path: string;
  duration: number | null;
  created_at: string;
}

export interface MusicProfile {
  energy: number;
  dynamics: number;
  brightness: number;
  descriptors: string[];
  energyBand?: "low" | "medium" | "high";
}

export interface BeatInfo {
  bpm: number;
  beatTimestamps: number[];
  cutTimestamps: number[];
  windowStart: number;
  windowEnd: number;
  numCuts: number;
  duration: number;
  segmentDurations: number[];
  clipsPerBeat: 1 | 2;
  musicProfile?: MusicProfile;
}

export interface OrderedClip {
  position: number;
  clip_id: string;
  category: Category;
  role?: string;
}

export interface ClipSelection {
  start: number;
  end: number;
}

export interface TextOverlay {
  enabled: boolean;
  text: string;
  size: number;
  font: "EB Garamond" | "Inter" | "Noto Sans" | "DejaVu Sans";
}

export interface SequenceItem {
  position: number;
  category: Category;
  role?: string;
  clip: Clip & { url: string | null };
  sourceStart: number;
  sourceEnd: number;
  targetDuration: number;
  locked?: boolean;
  /** FFmpeg shot analysis for the chosen section (absent for manual/locked sections). */
  shot?: { status: "ok" | "short-shot" | "clip-too-short" | "unverified"; shotStart: number; shotEnd: number; note?: string };
  /** True when no cut-free shot was long enough: the section is one shorter shot and the renderer holds its last frame. */
  shortShot?: boolean;
}

export interface ReferenceBeatSync {
  cutTime: number;
  nearestBeat: number | null;
  offset: number | null;
  aligned: boolean;
}

export interface ReferenceShotAnalysis {
  index: number;
  start: number;
  end: number;
  duration: number;
  primarySubject: string;
  subjectTags: string[];
  peoplePresent: boolean | null;
  composition: string;
  cameraMovement: string;
  movementDirection: string;
  motionLevel: string;
  action: string;
  role: string;
  visualImpact: number;
  editingIntent: string;
  brightness?: number;
  saturation?: number;
  contrast?: number;
  edgeDensity?: number;
  frameChange?: number;
  dominantTone?: string;
}

export interface ReferenceFingerprint {
  hookStructure: Record<string, unknown>;
  subjectProgression: string[];
  subjectMix: string[];
  repetitionPatterns: Record<string, unknown>;
  compositionPattern: Record<string, unknown>;
  movementContinuity: Record<string, unknown>;
  endingPayoff: Record<string, unknown>;
  beatSync: Record<string, unknown>;
  styleFingerprint: Record<string, unknown>;
}

export interface ReferenceAnalysis {
  duration: number;
  cutTimestamps: number[];
  cutCount: number;
  durations: number[];
  pattern: string[];
  hookDuration: number | null;
  averageCutDuration: number;
  endingDuration: number | null;
  beatTimestamps: number[];
  beatSync: ReferenceBeatSync[];
  shots: ReferenceShotAnalysis[];
  fingerprint: ReferenceFingerprint;
  visualShotCount?: number;
  visualShotTotal?: number;
}

export interface LoadedReference {
  id: string;
  path: string;
  name: string;
  analysis: ReferenceAnalysis;
}
