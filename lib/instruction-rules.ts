import { Clip } from "@/types";
import { parseClipMetadata } from "@/lib/music-compatibility";

/**
 * Hard rules extracted from the user's saved Reel Style Instructions.
 *
 * The LLM only ever *sees* text instructions, and LLMs ignore "avoid X" often
 * enough that it cannot be trusted with hard constraints. So the constraints
 * that can be checked mechanically are enforced HERE, before the model is
 * called, by removing clips from the pool. The model (and the fallback filler)
 * can then only ever pick from clips that already obey the rules.
 *
 * Enforced:
 *  - "avoid / never / no / without / exclude / skip ... <folder or tag>"  -> clips removed
 *  - "energetic / high energy / fast paced ..."  -> only clips whose filename says so (strict tier)
 *  - "calm / slow / low energy ..."               -> only clips whose filename says so
 *  - "avoid slow / static ..." / "avoid high energy ..." -> matching clips removed
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "from", "in", "on", "at", "to", "and", "or", "any", "all", "every", "anything", "everything",
  "view", "folder", "category", "categorie", "clip", "video", "footage", "shot", "scene", "content", "stuff", "thing", "file",
  "completely", "totally", "absolutely", "strictly", "please", "also", "too", "reel", "it", "this", "that", "these", "those",
  "my", "me", "with", "for", "be", "is", "are", "use", "using", "include", "show", "showing", "kind", "type", "related", "like", "ever",
]);

const CUE = /\b(?:do\s+not|don'?t|dont|never|avoid(?:ing)?|exclude|excluding|without|skip|remove|ban|no|stay\s+away\s+from|leave\s+out|nothing\s+from)(?:\s+(?:use|using|include|including|show|showing|add|adding|want|any|the))*\b/i;
const END_OF_NEGATIVE = /\b(?:but|except|however|instead|although|though|prefer|favou?r|focus|rather)\b|,\s*(?:and\s+)?(?:use|make|keep|add|show|include|only)\b/i;

const HIGH_WORDS = /\b(?:high[\s-]?energy|energetic|energy|fast[\s-]?paced|fast|intense|aggressive|hype|adrenaline|upbeat)\b/i;
const LOW_WORDS = /\b(?:low[\s-]?energy|calm|slow[\s-]?paced|slow|chill|relaxed|peaceful|serene|quiet|static|stationary|still)\b/i;
const HIGH_NEG = /\b(?:high[\s-]?energy|energetic|fast[\s-]?paced|fast|intense|aggressive|hype)\b/i;
const LOW_NEG = /\b(?:low[\s-]?energy|static|stationary|still|slow[\s-]?paced|slow|calm|peaceful|serene|relaxed|quiet)\b/i;

function stem(word: string) {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}
function tokens(text: string) {
  return text.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}
const contentTokens = (text: string) => tokens(text).filter((t) => !STOP_WORDS.has(t));

const isHigh = (c: Clip) => { const m = parseClipMetadata(c); return m.energy === "high" || m.pace === "fast" || m.motion === "dynamic"; };
const isLow = (c: Clip) => { const m = parseClipMetadata(c); return m.energy === "low" || m.pace === "slow" || m.motion === "static"; };

export interface InstructionRules {
  clips: Clip[];
  excludedCategories: string[];
  excludedTags: string[];
  energyMode: "high" | "low" | null;
  notes: string[];
  error?: string;
}

export function applyInstructionRules(
  clips: Clip[],
  instructions: string,
  categories: string[],
  keepIds: Set<string>,
  minNeeded: number,
): InstructionRules {
  const text = (instructions ?? "").toLowerCase();
  const notes: string[] = [];
  if (!text.trim()) return { clips, excludedCategories: [], excludedTags: [], energyMode: null, notes };

  const catInfo = categories.map((name) => ({ name, toks: contentTokens(name) })).filter((c) => c.toks.length);
  const excludedCategories = new Set<string>();
  const excludedTags = new Set<string>();
  let excludeHigh = false;
  let excludeLow = false;
  const positive: string[] = [];

  for (const sentence of text.split(/[.!?\n;]+/)) {
    if (!sentence.trim()) continue;
    const parts = sentence.split(CUE);
    positive.push(parts[0]);
    for (const part of parts.slice(1)) {
      const cut = part.search(END_OF_NEGATIVE);
      const negative = cut >= 0 ? part.slice(0, cut) : part;
      if (cut >= 0) positive.push(part.slice(cut));
      const segTokens = contentTokens(negative);
      const segSet = new Set(segTokens);

      // 1) whole-category match: every word of the folder name is present.
      let matched = catInfo.filter((c) => c.toks.every((t) => segSet.has(t)));
      // 2) fallback: a word that belongs to exactly one folder ("jets" -> "private jets").
      if (!matched.length) {
        const viaUnique = new Set<string>();
        for (const t of segSet) {
          const owners = catInfo.filter((c) => c.toks.includes(t));
          if (owners.length === 1) viaUnique.add(owners[0].name);
        }
        matched = catInfo.filter((c) => viaUnique.has(c.name));
      }
      for (const c of matched) excludedCategories.add(c.name.trim().toLowerCase());

      if (HIGH_NEG.test(negative)) excludeHigh = true;
      if (LOW_NEG.test(negative)) excludeLow = true;
      // Free-form filename tags only when the phrase did not name a folder, so
      // "avoid private jets" does not also wipe out "private yacht" clips.
      if (!matched.length && !HIGH_NEG.test(negative) && !LOW_NEG.test(negative)) for (const t of segTokens) excludedTags.add(t);
    }
  }

  const positiveText = positive.join(" ");
  const wantsHigh = HIGH_WORDS.test(positiveText);
  const wantsLow = LOW_WORDS.test(positiveText);
  const energyMode: "high" | "low" | null = wantsHigh && !wantsLow ? "high" : wantsLow && !wantsHigh ? "low" : null;

  const violates = (clip: Clip) => {
    if (keepIds.has(clip.id)) return false; // user-locked clips are the user's own explicit choice
    if (excludedCategories.has(String(clip.category ?? "").trim().toLowerCase())) return true;
    if (excludedTags.size) {
      const fileTokens = tokens(clip.filename);
      if (fileTokens.some((t) => excludedTags.has(t))) return true;
    }
    if (excludeHigh && isHigh(clip)) return true;
    if (excludeLow && isLow(clip)) return true;
    return false;
  };

  let pool = clips.filter((c) => !violates(c));
  const removed = clips.length - pool.length;
  if (excludedCategories.size) notes.push(`Excluded folders: ${Array.from(excludedCategories).join(", ")}.`);
  if (excludedTags.size) notes.push(`Excluded filename words: ${Array.from(excludedTags).join(", ")}.`);
  if (excludeHigh) notes.push("Excluded high-energy clips.");
  if (excludeLow) notes.push("Excluded slow/static clips.");
  if (removed) notes.push(`${removed} clip${removed === 1 ? "" : "s"} removed by your instructions.`);

  if (energyMode) {
    const wanted = energyMode === "high" ? isHigh : isLow;
    const opposing = energyMode === "high" ? isLow : isHigh;
    const explicit = pool.filter((c) => wanted(c));
    const neutral = pool.filter((c) => !wanted(c) && !opposing(c));
    const locked = pool.filter((c) => keepIds.has(c.id) && !explicit.includes(c) && !neutral.includes(c));
    const label = energyMode === "high" ? "energetic" : "calm";
    if (explicit.length >= minNeeded + 2) {
      pool = [...explicit, ...locked];
      notes.push(`${label}-only: using ${explicit.length} clips whose filenames say so.`);
    } else {
      pool = [...explicit, ...neutral, ...locked];
      notes.push(`Only ${explicit.length} clips are tagged ${label} in their filenames, so ${neutral.length} untagged clips were added to fill ${minNeeded} slots. Clips explicitly tagged the opposite were still excluded. Add tags like "${energyMode === "high" ? "fast" : "slow"}" or "${energyMode === "high" ? "high-energy" : "calm"}" to more filenames for stricter results.`);
    }
  }

  const result: InstructionRules = { clips: pool, excludedCategories: Array.from(excludedCategories), excludedTags: Array.from(excludedTags), energyMode, notes };
  if (pool.length < minNeeded) {
    result.error = `Your instructions leave only ${pool.length} usable clips, but this beat grid needs ${minNeeded}. ${notes.join(" ")} Upload more clips, loosen the instructions, or use a shorter song section / 1× beat density.`;
  }
  return result;
}
