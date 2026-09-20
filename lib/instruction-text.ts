/**
 * Splits free-text Reel Style Instructions into clauses and classifies them.
 * Pure text utilities, no dependencies, safe to import from anywhere.
 *
 * Why this exists: the old code matched instruction words against clip names
 * with no notion of negation, so "no private jets" *boosted* private-jet clips.
 * Everything that needs to know "is this word wanted, unwanted, or a variety rule?"
 * goes through here.
 */

// A clause that talks about ORDER / REPETITION / QUANTITY is a variety rule, never an exclusion.
// ("no car video after car video" must not exclude the Cars folder.)
const VARIETY_CLAUSE = /\b(?:next\s+to|back[\s-]?to[\s-]?back|in\s+a\s+row|consecutive(?:ly)?|adjacent|one\s+after\s+another|after\s+each\s+other|after|before|following|same|repeat(?:ed|ing)?|twice|more\s+than|at\s+most|no\s+more|too\s+many|too\s+much|max(?:imum)?|limit|variety|vary|varied|mix(?:ed)?)\b/i;
// The subset of variety wording that specifically means "do not put the same kind of clip side by side".
const ADJACENCY_CLAUSE = /\b(?:next\s+to|back[\s-]?to[\s-]?back|in\s+a\s+row|consecutive(?:ly)?|adjacent|one\s+after\s+another|after\s+each\s+other|after|same|repeat(?:ed|ing)?|twice)\b/i;

const CUE = /\b(?:do\s+not|don'?t|dont|never|avoid(?:ing)?|exclude|excluding|without|skip|remove|ban|no|stay\s+away\s+from|leave\s+out|nothing\s+from)(?:\s+(?:use|using|include|including|show|showing|add|adding|want|any|the))*\b/i;
const END_OF_NEGATIVE = /\b(?:but|except|however|instead|although|though|prefer|favou?r|focus|rather)\b|,\s*(?:and\s+)?(?:use|make|keep|add|show|include|only)\b/i;
// Commas only split clauses when a new directive starts, so "no jets, grind or views" stays one list.
const CLAUSE_SPLIT = /[.!?\n;]+|,\s*(?=(?:and\s+)?(?:make|keep|use|add|show|include|no|dont|don't|do\s+not|avoid|never|only|but|also|plus|then|prefer|favou?r|focus|without|skip)\b)/i;

export interface InstructionClauses {
  /** Text after a negation cue, e.g. "private jets or grind or views videos". */
  negativeSegments: string[];
  /** Everything that is a wish rather than a ban or a variety rule. Safe for positive keyword matching. */
  positiveText: string;
  /** Clauses about order/repetition/quantity. */
  varietyClauses: string[];
  /** True when a clause asks for no same-kind clips side by side. */
  wantsNoAdjacentRepeats: boolean;
}

export function splitInstructions(raw: string): InstructionClauses {
  const negativeSegments: string[] = [];
  const positive: string[] = [];
  const varietyClauses: string[] = [];
  let wantsNoAdjacentRepeats = false;

  for (const clause of String(raw ?? "").toLowerCase().split(CLAUSE_SPLIT)) {
    if (!clause || !clause.trim()) continue;
    if (VARIETY_CLAUSE.test(clause)) {
      varietyClauses.push(clause.trim());
      if (ADJACENCY_CLAUSE.test(clause)) wantsNoAdjacentRepeats = true;
      continue;
    }
    const parts = clause.split(CUE);
    positive.push(parts[0]);
    for (const part of parts.slice(1)) {
      const cut = part.search(END_OF_NEGATIVE);
      negativeSegments.push(cut >= 0 ? part.slice(0, cut) : part);
      if (cut >= 0) positive.push(part.slice(cut));
    }
  }
  return { negativeSegments, positiveText: positive.join(" "), varietyClauses, wantsNoAdjacentRepeats };
}

export const STOP_WORDS = new Set([
  "a", "an", "the", "of", "from", "in", "on", "at", "to", "and", "or", "any", "all", "every", "anything", "everything",
  "view", "folder", "category", "categorie", "clip", "video", "footage", "shot", "scene", "content", "stuff", "thing", "file",
  "completely", "totally", "absolutely", "strictly", "please", "also", "too", "reel", "it", "this", "that", "these", "those",
  "my", "me", "with", "for", "be", "is", "are", "use", "using", "include", "show", "showing", "kind", "type", "related", "like", "ever",
]);
// Tiny connector words. Folder-name matching drops only these, so a folder literally called "Views" or
// "Clips" can still be matched even though "view"/"clip" are stop words for free-form filename terms.
export const FILLER_WORDS = new Set(["a", "an", "the", "of", "and", "or", "to", "for", "in", "on", "at", "from", "with", "any", "all"]);

export function stem(word: string) {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}
export function tokens(text: string) {
  return String(text ?? "").toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").split(/[^a-z0-9]+/).filter(Boolean).map(stem);
}
