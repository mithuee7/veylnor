import { Clip } from "@/types";
import { parseClipMetadata } from "@/lib/music-compatibility";
import { FILLER_WORDS, STOP_WORDS, splitInstructions, stem, tokens } from "@/lib/instruction-text";

/**
 * HARD constraints extracted from the user's Reel Style Instructions.
 *
 * Design rule: only things that can be checked mechanically and that the user
 * stated as a prohibition or a variety rule are enforced in code:
 *   - "no private jets / avoid grind / without views"   -> those folders/words never reach the model
 *   - "don't put the same kind of clip next to each other" -> adjacent same-folder is repaired after the model answers
 *   - "energetic only"                                   -> clips whose filename EXPLICITLY says low-energy/slow/calm are dropped
 * Everything creative (which video, what order, what role, how it matches the song)
 * is left to Groq.
 */

export interface HardConstraints {
  excludedCategories: string[];        // exact folder names as stored in Supabase
  excludedTerms: string[];             // stemmed filename words, only words that really occur in the library
  energyDirection: "high" | "low" | null;  // what the user asked for ("energetic only" -> high)
  excludedEnergy: "high" | "low" | null;   // "no slow shots" -> clips whose filename says slow/calm are dropped
  noAdjacentSameCategory: boolean;
  notes: string[];                     // human-readable summary, shown in the UI and returned by the API
}

const HIGH_WORDS = /\b(?:high[\s-]?energy|energetic|fast[\s-]?paced|fast|intense|aggressive|hype|adrenaline|upbeat)\b/i;
const LOW_WORDS = /\b(?:low[\s-]?energy|calm|slow[\s-]?paced|slow|chill|relaxed|peaceful|serene|quiet)\b/i;
const HIGH_NEG = /\b(?:high[\s-]?energy|energetic|fast[\s-]?paced|fast|intense|aggressive|hype)\b/i;
const LOW_NEG = /\b(?:low[\s-]?energy|static|stationary|still|slow[\s-]?paced|slow|calm|peaceful|serene|relaxed|quiet)\b/i;

const catTokens = (name: string) => tokens(name).filter((t) => !FILLER_WORDS.has(t));
const termTokens = (text: string) => tokens(text).filter((t) => !STOP_WORDS.has(t));

export function parseHardConstraints(instructions: string, categories: string[], clips: Pick<Clip, "filename">[]): HardConstraints {
  const parsed = splitInstructions(instructions);
  const catInfo = categories.map((name) => ({ name, toks: catTokens(name) })).filter((c) => c.toks.length);
  const excludedCategories = new Set<string>();
  const excludedTerms = new Set<string>();
  let excludeHigh = false;
  let excludeLow = false;

  // Vocabulary of real filename words, so a stray word in the instructions cannot exclude anything by accident.
  const vocabulary = new Set<string>();
  for (const clip of clips) for (const t of tokens(clip.filename)) vocabulary.add(t);

  for (const segment of parsed.negativeSegments) {
    const allTokens = new Set(tokens(segment));
    // 1) every word of the folder name appears ("private jets" -> "Private Jet")
    let matched = catInfo.filter((c) => c.toks.every((t) => allTokens.has(t)));
    // 2) a word that belongs to exactly one folder ("jets" -> "Private Jet")
    if (!matched.length) {
      const viaUnique = new Set<string>();
      for (const t of allTokens) {
        if (STOP_WORDS.has(t) && !catInfo.some((c) => c.toks.length === 1 && c.toks[0] === t)) continue;
        const owners = catInfo.filter((c) => c.toks.includes(t));
        if (owners.length === 1) viaUnique.add(owners[0].name);
      }
      matched = catInfo.filter((c) => viaUnique.has(c.name));
    }
    for (const c of matched) excludedCategories.add(c.name);

    if (HIGH_NEG.test(segment)) excludeHigh = true;
    if (LOW_NEG.test(segment)) excludeLow = true;
    // Free filename words are only used when the phrase did not name a folder, so
    // "no private jets" does not also ban "private yacht" clips in another folder.
    if (!matched.length && !HIGH_NEG.test(segment) && !LOW_NEG.test(segment)) {
      for (const t of termTokens(segment)) if (vocabulary.has(t)) excludedTerms.add(t);
    }
  }

  const wantsHigh = HIGH_WORDS.test(parsed.positiveText);
  const wantsLow = LOW_WORDS.test(parsed.positiveText);
  const energyDirection: "high" | "low" | null = wantsHigh && !wantsLow ? "high" : wantsLow && !wantsHigh ? "low" : null;
  const excludedEnergy: "high" | "low" | null = excludeLow && !excludeHigh ? "low" : excludeHigh && !excludeLow ? "high" : null;

  const notes: string[] = [];
  if (excludedCategories.size) notes.push(`Excluded folders: ${Array.from(excludedCategories).join(", ")}.`);
  if (excludedTerms.size) notes.push(`Excluded filename words: ${Array.from(excludedTerms).join(", ")}.`);
  if (excludedEnergy) notes.push(`Excluded ${excludedEnergy}-energy clips (only where the filename says so).`);
  if (energyDirection) notes.push(`Energy requested: ${energyDirection === "high" ? "high / energetic" : "low / calm"} (overrides the song's own energy profile).`);
  if (parsed.wantsNoAdjacentRepeats) notes.push("Variety rule: no two clips from the same folder back to back.");

  return {
    excludedCategories: Array.from(excludedCategories),
    excludedTerms: Array.from(excludedTerms),
    energyDirection,
    excludedEnergy,
    noAdjacentSameCategory: parsed.wantsNoAdjacentRepeats,
    notes,
  };
}

/** Explicit means the FILENAME literally says it ("calm", "slow-paced", "low-energy"), not that Groq guessed. */
function explicitEnergy(clip: Clip): "high" | "low" | null {
  const meta = parseClipMetadata(clip);
  if (meta.energy === "low" || meta.pace === "slow") return "low";
  if (meta.energy === "high" || meta.pace === "fast") return "high";
  return null;
}

export function violatesConstraints(clip: Clip, constraints: HardConstraints, keepIds: Set<string> = new Set(), ignoreEnergy = false): boolean {
  if (keepIds.has(clip.id)) return false; // the user's own locked clips are their explicit choice
  const category = String(clip.category ?? "").trim().toLowerCase();
  if (constraints.excludedCategories.some((name) => name.trim().toLowerCase() === category)) return true;
  if (constraints.excludedTerms.length) {
    const fileTokens = new Set(tokens(clip.filename));
    if (constraints.excludedTerms.some((t) => fileTokens.has(t))) return true;
  }
  if (!ignoreEnergy) {
    const energy = explicitEnergy(clip);
    if (energy && constraints.excludedEnergy === energy) return true;
    if (energy && constraints.energyDirection && energy !== constraints.energyDirection) return true;
  }
  return false;
}

export function sameCategory(a: { category?: string } | undefined, b: { category?: string } | undefined) {
  return Boolean(a && b && String(a.category ?? "").trim().toLowerCase() === String(b.category ?? "").trim().toLowerCase());
}

export { stem };
