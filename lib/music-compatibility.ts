import { BeatInfo, Clip, MusicProfile } from "@/types";
import { STOP_WORDS, splitInstructions, stem, tokens as stemTokens } from "@/lib/instruction-text";

type EnergyBand = "low" | "medium" | "high";

export interface ClipMetadata {
  subject: string;
  tags: string[];
  energy: "low" | "medium" | "high" | "unknown";
  pace: "slow" | "medium" | "fast" | "unknown";
  motion: "static" | "dynamic" | "unknown";
}

const HIGH_TAGS = new Set(["high-energy", "energetic", "fast", "fast-paced", "dynamic", "action", "aggressive", "intense", "driving", "running", "movement", "motion"]);
const LOW_TAGS = new Set(["low-energy", "calm", "peaceful", "slow", "slow-paced", "static", "still", "serene", "quiet", "relaxed"]);
const FAST_TAGS = new Set(["fast", "fast-paced", "quick", "rapid", "high-speed"]);
const SLOW_TAGS = new Set(["slow", "slow-paced", "calm", "peaceful", "relaxed", "serene"]);
const DYNAMIC_TAGS = new Set(["dynamic", "action", "driving", "running", "movement", "motion", "tracking", "aerial", "chase", "dance", "dancing"]);
const STATIC_TAGS = new Set(["static", "still", "stationary", "peaceful", "calm", "slow"]);

function normalise(value: string) {
  return value.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(/[^a-z0-9]+/).filter(Boolean);
}

export function parseClipMetadata(clip: Pick<Clip, "filename" | "category">): ClipMetadata {
  const rawFilename = clip.filename.replace(/\.[a-z0-9]{2,5}$/i, "");
  const chunks = rawFilename.split(/__+|[|,;]/).map((part) => normalise(part)).filter(Boolean);
  const tokenTags = chunks.flatMap((chunk) => tokenise(chunk));
  // normalise() turns hyphens into spaces, so "high-energy" would never survive as a single token.
  // Detect the two-word energy phrases explicitly, and never treat a bare "low"/"high" ("low-angle", "high-rise") as energy.
  const phrases: string[] = [];
  const whole = normalise(rawFilename);
  if (/\bhigh energy\b/.test(whole)) phrases.push("high-energy");
  if (/\blow energy\b/.test(whole)) phrases.push("low-energy");
  const tags = Array.from(new Set([...chunks, ...tokenTags, ...phrases]));
  const high = tags.some((tag) => HIGH_TAGS.has(tag));
  const low = tags.some((tag) => LOW_TAGS.has(tag));
  const fast = tags.some((tag) => FAST_TAGS.has(tag));
  const slow = tags.some((tag) => SLOW_TAGS.has(tag));
  const dynamic = tags.some((tag) => DYNAMIC_TAGS.has(tag));
  const staticShot = tags.some((tag) => STATIC_TAGS.has(tag));
  return {
    subject: clip.category,
    tags,
    energy: high && !low ? "high" : low && !high ? "low" : "unknown",
    pace: fast && !slow ? "fast" : slow && !fast ? "slow" : "unknown",
    motion: dynamic && !staticShot ? "dynamic" : staticShot && !dynamic ? "static" : "unknown",
  };
}

export function getEnergyBand(profile?: MusicProfile | null, bpm?: number): EnergyBand {
  const energy = Number(profile?.energy ?? 0);
  const tempo = Number(bpm ?? 0);
  if (profile?.descriptors?.includes("high-impact") || profile?.descriptors?.includes("energetic") || energy >= 0.68 || tempo >= 145) return "high";
  if (profile?.descriptors?.includes("calm") || profile?.descriptors?.includes("cinematic/slow") || (energy <= 0.38 && tempo <= 105)) return "low";
  return "medium";
}

/**
 * Music compatibility is intentionally a soft signal. Folder names are subject/context,
 * not hard-coded energy categories. The saved Reel Style Instructions and filename tags
 * are allowed to override generic music assumptions.
 */
export function getMusicCompatibleClips(
  clips: Clip[],
  beatInfo: BeatInfo,
): { clips: Clip[]; band: EnergyBand; preferredCategories: string[]; avoidedCategories: string[]; hardAvoidedCategories: string[] } {
  const band = getEnergyBand(beatInfo.musicProfile, beatInfo.bpm);
  const scored = clips.map((clip) => ({ clip, meta: parseClipMetadata(clip) }));
  const preferred = scored.filter(({ meta }) => band === "high" ? (meta.energy === "high" || meta.pace === "fast" || meta.motion === "dynamic") : band === "low" ? (meta.energy === "low" || meta.pace === "slow" || meta.motion === "static") : true);
  const preferredCategories = Array.from(new Set(preferred.map(({ clip }) => clip.category)));
  const avoidedCategories: string[] = [];
  const hardAvoidedCategories: string[] = [];
  return { clips, band, preferredCategories, avoidedCategories, hardAvoidedCategories };
}

export function scoreClipForGeneration(
  clip: Clip,
  band: EnergyBand,
  reelInstructions: string,
): number {
  const meta = parseClipMetadata(clip);
  let score = 0;
  if (band === "high") {
    if (meta.energy === "high") score += 7;
    if (meta.pace === "fast") score += 5;
    if (meta.motion === "dynamic") score += 5;
  } else if (band === "low") {
    if (meta.energy === "low") score += 7;
    if (meta.pace === "slow") score += 5;
    if (meta.motion === "static") score += 5;
  }
  // Only WANTED text may boost a clip. Bans ("no private jets") and variety rules
  // ("no car after car") are stripped first; matching them here is what used to
  // rank the banned folders at the top of the candidate list.
  const wanted = new Set(stemTokens(splitInstructions(reelInstructions).positiveText).filter((t) => !STOP_WORDS.has(t)));
  if (wanted.size) {
    const tagSet = new Set(meta.tags.map(stem));
    for (const token of wanted) if (tagSet.has(token)) score += 6;
    for (const token of stemTokens(clip.category)) if (wanted.has(token)) score += 8;
  }
  return score;
}
