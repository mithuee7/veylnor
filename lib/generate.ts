import "server-only";
import { Clip, BeatInfo, OrderedClip, ReferenceAnalysis } from "@/types";
import { getEnergyBand, scoreClipForGeneration } from "@/lib/music-compatibility";
import { HardConstraints, parseHardConstraints, sameCategory, violatesConstraints } from "@/lib/instruction-constraints";

// ---------------------------------------------------------------------------
// What Groq is responsible for, and what it is not
// ---------------------------------------------------------------------------
// Groq decides WHICH video goes in WHICH slot (creative choice, ordering, roles, variety,
// fit to the song). It never invents source timestamps: FFmpeg picks the exact shot later.
// Hard user prohibitions ("no private jets") are enforced in code BEFORE Groq is called
// (forbidden clips are never shown to it) and order rules are verified AFTER it answers.
// Both the normal UI (/api/generate) and the n8n API (/api/v1/reels) call this function
// through lib/sequence-pipeline.ts, so there is exactly one selection path.

const SYSTEM_PROMPT = `You are the sequencing director for Veylnor, a short-form luxury-lifestyle reel editor.
Your job: decide WHICH video goes in WHICH slot. You cannot see the footage. For every clip you get its folder name and its filename; the filename describes what is on screen, so read it as a description of the shot.

You receive two kinds of instructions:
1. USER RULES - explicit prohibitions and rules the user stated (forbidden folders or words, energy requests, ordering/variety rules) plus count, uniqueness and duration rules. Obey them strictly: never pick a clip from a folder the user excluded, or whose filename matches an excluded word, even if it appears in the list and even if it looks like a good fit. Rules about what NOT to include are absolute; everything else is your call.
2. CREATIVE GUIDANCE - the user's style notes, the song's energy and any reference editing language. This is where you use judgment and taste.

Always:
- Use only ids from the CLIPS list, each id at most once, exactly one id per position.
- A clip's "sec" must be >= the position's seconds.
- Never invent attributes that are not in the folder or filename.
- Build a strong hook, purposeful pacing, escalation where it fits, and a satisfying final shot.
- Vary subject matter and visual attributes across the reel; do not stack similar shots back to back unless nothing else fits.
- If the user asked for a particular energy, that request overrides the song's own energy profile.
- Reference blueprints, when present, are only broad editing language (rhythm, composition variety, hook and payoff shape). Never copy footage or an exact sequence.`;

interface GenerateArgs {
  clips: Clip[];
  beatInfo: BeatInfo;
  references?: ReferenceAnalysis[] | null;
  reelInstructions?: string;
  locked?: OrderedClip[];
  avoidOrderClipIds?: string[][];
  availableCategories: string[];
}

export interface GenerateResult {
  ordered: OrderedClip[];
  warning?: string;
  constraints: HardConstraints;
  /** Allowed clips, best first, folder-interleaved. Used for shot-based swaps. */
  pool: Clip[];
  /** 1-based positions that Groq did not fill validly and the local filler had to choose. */
  fallbackPositions: number[];
}

type CompactReferenceFingerprint = {
  hookStructure?: { compositions?: string[]; motion?: string[]; cameraMovement?: string[]; durations?: number[] };
  repetitionPatterns?: { motionSequence?: string[]; cameraSequence?: string[]; toneSequence?: string[] };
  compositionPattern?: { sequence?: string[]; variety?: number | null };
  beatSync?: { alignedCutRatio?: number | null; cutOffsets?: Array<number | null> };
  endingPayoff?: { compositions?: string[]; motion?: string[]; visualImpact?: number[]; strongestShot?: number | null };
};


const stripExt = (name: string) => String(name ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MANIFEST_CHAR_BUDGET = Math.max(6000, Number(process.env.VEYNLOR_MANIFEST_CHARS ?? 20000));

/** Round-robin across folders, keeping rank order inside each folder, so any prefix/slice is folder-diverse. */
function interleaveByCategory(ranked: Clip[]): Clip[] {
  const buckets = new Map<string, Clip[]>();
  for (const clip of ranked) {
    const key = String(clip.category ?? "").trim().toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(clip);
  }
  const lists = Array.from(buckets.values());
  const out: Clip[] = [];
  for (let i = 0; out.length < ranked.length; i++) for (const list of lists) if (i < list.length) out.push(list[i]);
  return out;
}

export async function generateSequence({ clips, beatInfo, references, reelInstructions, locked, avoidOrderClipIds, availableCategories }: GenerateArgs): Promise<GenerateResult> {
  const segmentDurations = beatInfo.segmentDurations.map(Number);
  const numCuts = beatInfo.numCuts;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");

  // -------------------------------------------------------------------------
  // 1. Candidate library + HARD constraints (code-enforced, before Groq sees anything)
  // -------------------------------------------------------------------------
  const categorySet = new Set(availableCategories.map((category) => category.trim()).filter(Boolean));
  const taxonomyClips = clips.filter((c) => categorySet.has(String(c.category ?? "").trim()));
  const lockedIds = new Set((locked ?? []).map((item) => item.clip_id));
  const constraints = parseHardConstraints(reelInstructions ?? "", availableCategories, taxonomyClips);

  // DEFAULT: Groq decides. The parsed rules are handed to Groq as explicit USER RULES and nothing is removed from its list.
  // Optional strict mode (VEYNLOR_ENFORCE_CONSTRAINTS=1) removes forbidden clips before Groq and repairs order rules afterwards.
  const enforce = process.env.VEYNLOR_ENFORCE_CONSTRAINTS === "1";
  const flagged = (clip: Clip) => violatesConstraints(clip, constraints, lockedIds);
  let pool = enforce ? taxonomyClips.filter((clip) => !flagged(clip)) : [...taxonomyClips];
  const warnings: string[] = [];
  if (enforce && pool.length < numCuts + 2 && (constraints.energyDirection || constraints.excludedEnergy)) {
    const relaxed = taxonomyClips.filter((clip) => !violatesConstraints(clip, constraints, lockedIds, true));
    if (relaxed.length > pool.length) {
      pool = relaxed;
      warnings.push("Not enough clips are explicitly tagged for the requested energy in their filenames, so that filename filter was relaxed.");
    }
  }
  if (pool.length < numCuts) {
    throw new Error(`This beat grid needs ${numCuts} unique clips, but only ${pool.length} are available${enforce && constraints.notes.length ? ` after your instructions (${constraints.notes.join(" ")})` : ""}. Add more clips or use a shorter song section.`);
  }

  const songBand = getEnergyBand(beatInfo.musicProfile, beatInfo.bpm);
  const rankingBand = constraints.energyDirection ?? songBand;
  const maxNeededDuration = Math.max(...segmentDurations, 0);
  const scoreOf = new Map(pool.map((clip) => [clip.id, scoreClipForGeneration(clip, rankingBand, reelInstructions ?? "") + (Number(clip.duration ?? 0) + 0.01 >= maxNeededDuration ? 2 : 0) - (flagged(clip) ? 100 : 0)]));
  const ranked = [...pool].sort((a, b) => (scoreOf.get(b.id)! - scoreOf.get(a.id)!) || String(a.id).localeCompare(String(b.id)));
  const diverse = interleaveByCategory(ranked);

  // Short ids ("c12") keep the prompt small and remove UUID typos. They map 1:1 to real clip ids.
  const codeOf = new Map(diverse.map((clip, index) => [clip.id, `c${index + 1}`]));
  const clipByCode = new Map(diverse.map((clip) => [codeOf.get(clip.id)!, clip]));
  const compact = (clip: Clip) => ({
    id: codeOf.get(clip.id)!,
    folder: clip.category,
    file: stripExt(clip.filename),
    sec: clip.duration == null ? null : Number(Number(clip.duration).toFixed(1)),
  });
  // Compact reference blueprints. The local analyzer keeps much richer data,
  // but the generation model only needs the highest-value editing signals.
  const referenceText = (references ?? []).slice(0, 5).map((reference, index) => {
    const fingerprint = reference.fingerprint as CompactReferenceFingerprint;
    return {
      ref: index + 1,
      duration: Number(reference.duration.toFixed(1)),
      cuts: reference.cutCount,
      avgCut: Number(reference.averageCutDuration.toFixed(2)),
      hook: {
        duration: reference.hookDuration == null ? null : Number(reference.hookDuration.toFixed(2)),
        compositions: fingerprint.hookStructure?.compositions ?? [],
        motion: fingerprint.hookStructure?.motion ?? [],
        cameras: fingerprint.hookStructure?.cameraMovement ?? [],
        shotDurations: (fingerprint.hookStructure?.durations as number[] | undefined)?.slice(0, 4) ?? [],
      },
      middle: {
        composition: (fingerprint.compositionPattern?.sequence as string[] | undefined)?.slice(0, 8) ?? [],
        motion: (fingerprint.repetitionPatterns?.motionSequence as string[] | undefined)?.slice(0, 8) ?? [],
        camera: (fingerprint.repetitionPatterns?.cameraSequence as string[] | undefined)?.slice(0, 8) ?? [],
        tones: (fingerprint.repetitionPatterns?.toneSequence as string[] | undefined)?.slice(0, 8) ?? [],
        variety: fingerprint.compositionPattern?.variety ?? null,
      },
      beat: {
        alignedRatio: fingerprint.beatSync?.alignedCutRatio ?? null,
        offsets: (fingerprint.beatSync?.cutOffsets as Array<number | null> | undefined)?.filter((x): x is number => typeof x === "number").slice(0, 8) ?? [],
      },
      ending: {
        duration: reference.endingDuration == null ? null : Number(reference.endingDuration.toFixed(2)),
        compositions: fingerprint.endingPayoff?.compositions ?? [],
        motion: fingerprint.endingPayoff?.motion ?? [],
        impact: fingerprint.endingPayoff?.visualImpact ?? [],
        strongestShot: fingerprint.endingPayoff?.strongestShot ?? null,
      },
      // Only a few representative shots are needed for the sequencing model.
      shots: reference.shots.slice(0, 4).map(shot => ({
        d: Number(shot.duration.toFixed(2)),
        comp: shot.composition,
        move: shot.motionLevel,
        cam: shot.cameraMovement,
        impact: shot.visualImpact,
      })),
    };
  });


  const musicText = {
    bpm: beatInfo.bpm,
    energy: beatInfo.musicProfile?.energy ?? null,
    dynamics: beatInfo.musicProfile?.dynamics ?? null,
    brightness: beatInfo.musicProfile?.brightness ?? null,
    descriptors: beatInfo.musicProfile?.descriptors ?? [],
    songEnergyBand: songBand,
  };

  // -------------------------------------------------------------------------
  // 2. Prompt sections
  // -------------------------------------------------------------------------
  const positions = segmentDurations.map((seconds, index) => ({ position: index + 1, seconds: Number(seconds.toFixed(3)) }));
  const lockedText = (locked ?? []).slice(0, 24).map((lock) => {
    const clip = clips.find((c) => c.id === lock.clip_id);
    return clip ? { position: lock.position, id: codeOf.get(clip.id) ?? clip.id, folder: clip.category, file: stripExt(clip.filename) } : null;
  }).filter(Boolean);

  const hardLines: string[] = [];
  const removedNote = enforce ? " (already removed from the list)" : "";
  if (constraints.excludedCategories.length) hardLines.push(`DO NOT use clips from these folders${removedNote}: ${constraints.excludedCategories.join(", ")}.`);
  if (constraints.excludedTerms.length) hardLines.push(`DO NOT use clips whose filename contains${removedNote}: ${constraints.excludedTerms.join(", ")}.`);
  if (constraints.excludedEnergy) hardLines.push(`The user does not want ${constraints.excludedEnergy}-energy footage: skip clips whose filename says so.`);
  if (constraints.energyDirection) hardLines.push(`The user asked for ${constraints.energyDirection === "high" ? "HIGH-ENERGY, energetic, fast, dynamic" : "LOW-ENERGY, calm, slow"} footage. Pick only clips whose filename/folder supports that; this overrides the song's own energy profile (song energy band: ${songBand}).`);
  if (constraints.noAdjacentSameCategory) hardLines.push("No two consecutive positions may use clips from the same folder.");
  hardLines.push(`Exactly ${numCuts} positions, one unique clip id each; clip "sec" must be >= the position's seconds.`);
  if (lockedText.length) hardLines.push(`Locked positions must keep their clip: ${JSON.stringify(lockedText)}`);

  const softVariety = constraints.noAdjacentSameCategory ? "" : "\n- Prefer variety: avoid putting clips from the same folder or with the same subject back to back unless nothing else fits.";
  const guidance = `CREATIVE GUIDANCE (flexible, use judgment):
- User's style instructions, verbatim: ${JSON.stringify((reelInstructions?.trim() || "none").slice(0, 1800))}
- Song: BPM ${beatInfo.bpm}, section ${beatInfo.windowStart}s-${beatInfo.windowEnd}s (${beatInfo.duration}s), ${beatInfo.clipsPerBeat} clip(s) per beat. Music profile: ${JSON.stringify(musicText)}${constraints.energyDirection ? " (the user's energy request overrides this)" : ""}.
- Reference blueprints (secondary, broad editing language only): ${JSON.stringify(referenceText)}${softVariety}`;

  const previousOrdersText = avoidOrderClipIds?.length
    ? `\n- The user just regenerated. Avoid repeating these earlier orders (real clip ids, truncated): ${JSON.stringify(avoidOrderClipIds.slice(0, 2).map((order) => order.slice(0, Math.min(order.length, numCuts, 18)).map((id) => codeOf.get(id) ?? id)))}`
    : "";
  // ---------------------------------------------------------------------------
  // Groq plumbing
  // ---------------------------------------------------------------------------
  // openai/gpt-oss-120b is a REASONING model. Its hidden reasoning tokens are
  // drawn from the same max_tokens budget as the visible answer. If the budget
  // is too small the model burns everything on reasoning, returns an empty
  // message, and Groq's JSON validator rejects it with:
  //   400 json_validate_failed, failed_generation: ""
  // So: (1) keep reasoning effort low, (2) give generous headroom, and
  // (3) retry with a bigger budget / no strict JSON mode before giving up.
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const groqFetch = async (body: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (response.status !== 429 || attempt === 3) return response;
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      await sleep(Math.max(2000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
    }
    throw new Error("Groq request failed after retries");
  };

  function extractJson(raw: string): any {
    const cleaned = raw.replace(/```json|```/gi, "").trim();
    try { return JSON.parse(cleaned); } catch { /* fall through */ }
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("No JSON object found in model output");
  }

  async function groqJson(label: string, system: string, user: string, opts: { maxTokens: number; temperature: number }): Promise<any> {
    const attempts = [
      { maxTokens: opts.maxTokens, jsonMode: true },
      { maxTokens: Math.min(opts.maxTokens * 2, 8192), jsonMode: true },
      { maxTokens: Math.min(opts.maxTokens * 2, 8192), jsonMode: false }, // last resort: plain text, parse ourselves
    ];
    let lastError = "unknown error";
    for (const attempt of attempts) {
      const response = await groqFetch({
        model: "openai/gpt-oss-120b",
        temperature: opts.temperature,
        reasoning_effort: "low",
        include_reasoning: false,
        ...(attempt.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: attempt.maxTokens,
      });
      if (!response.ok) {
        const text = await response.text();
        lastError = `${label}: Groq ${response.status} ${text.slice(0, 500)}`;
        // Retry only on the "empty / invalid JSON" family and transient 5xx. Anything else is a real config error.
        const retryable = response.status >= 500 || (response.status === 400 && /json_validate_failed|Failed to validate JSON/i.test(text));
        if (!retryable) throw new Error(`Groq request failed: ${response.status} ${text}`);
        continue;
      }
      const data = await response.json();
      const choice = data.choices?.[0];
      const raw = choice?.message?.content;
      if (!raw || !String(raw).trim()) {
        lastError = `${label}: empty content (finish_reason=${choice?.finish_reason ?? "?"}; reasoning used the whole token budget)`;
        continue;
      }
      try { return extractJson(String(raw)); }
      catch { lastError = `${label}: model returned invalid JSON (finish_reason=${choice?.finish_reason ?? "?"})`; }
    }
    throw new Error(`Groq could not produce valid JSON. ${lastError}`);
  }


  // -------------------------------------------------------------------------
  // 3. Candidate pass (only for libraries too large for one request)
  // -------------------------------------------------------------------------
  const allCompactChars = JSON.stringify(diverse.map(compact)).length;
  let warning: string | undefined;
  let finalPool: Clip[] = diverse;

  if (allCompactChars > MANIFEST_CHAR_BUDGET) {
    const batchCount = Math.max(2, Math.min(5, Math.ceil(allCompactChars / (MANIFEST_CHAR_BUDGET * 0.45))));
    // Deal the folder-interleaved, rank-ordered list into batches like cards, so EVERY batch contains every folder
    // and the same quality of clip. (Previously batches were raw database slices: one batch could be "only Views + Private Jet".)
    const batches: Clip[][] = Array.from({ length: batchCount }, () => []);
    diverse.forEach((clip, index) => batches[index % batchCount].push(clip));

    const perBatch = Math.min(Math.max(numCuts * 2, 8), 16);
    const candidateIds = new Set<string>();
    let failedBatches = 0;
    for (let i = 0; i < batches.length; i++) {
      const prompt = `${hardLines.filter((l) => !/^Exactly|^Locked/.test(l)).map((l) => `- ${l}`).join("\n") || "- none"}

${guidance}

Positions and durations: ${JSON.stringify(positions)}

CLIPS (batch ${i + 1} of ${batches.length}):
${JSON.stringify(batches[i].map(compact))}

Pick up to ${perBatch} clips from THIS batch that best serve the reel, best first. You may return fewer; never pad with clips that do not fit the instructions or the song. Use only ids from this batch.
Return ONLY JSON: {"candidates":[{"id":"c12","fit":90}]}`;
      try {
        const result = await groqJson(`candidate batch ${i + 1}`, "You are Veylnor's clip-candidate selector. Be concise. Use only supplied clip ids and read filenames as shot descriptions.", prompt, { maxTokens: 2048 + perBatch * 40, temperature: 0.4 });
        if (Array.isArray(result.candidates)) for (const item of result.candidates) {
          const clip = clipByCode.get(String(item?.id ?? item?.clip_id ?? ""));
          if (clip) candidateIds.add(clip.id);
        }
      } catch (e) {
        failedBatches++;
        console.error("[generate] candidate batch failed:", (e as Error).message);
      }
      if (i < batches.length - 1) await sleep(1200);
    }
    if (failedBatches) warning = `${failedBatches} of ${batches.length} AI candidate passes failed; part of the library was ranked locally instead.`;

    // Keep the shortlist, then top up from the folder-interleaved ranking so the pool is never thin or one-folder.
    const chosen = diverse.filter((clip) => candidateIds.has(clip.id) || lockedIds.has(clip.id));
    const chosenIds = new Set(chosen.map((clip) => clip.id));
    const minPool = Math.max(numCuts * 3, 24);
    for (const clip of diverse) { if (chosen.length >= minPool) break; if (!chosenIds.has(clip.id)) { chosen.push(clip); chosenIds.add(clip.id); } }
    finalPool = chosen;
  }
  for (const clip of taxonomyClips) if (lockedIds.has(clip.id) && !finalPool.some((c) => c.id === clip.id)) {
    finalPool = [...finalPool, clip];
    if (!codeOf.has(clip.id)) { const code = `c${codeOf.size + 1}`; codeOf.set(clip.id, code); clipByCode.set(code, clip); }
  }

  // -------------------------------------------------------------------------
  // 4. Final sequencing call
  // -------------------------------------------------------------------------
  const buildFinalPrompt = (poolForPrompt: Clip[]) => `USER RULES (obey strictly):
${hardLines.map((line) => `- ${line}`).join("\n")}

${guidance}${previousOrdersText}

POSITIONS (in order, with the seconds each slot needs):
${JSON.stringify(positions)}

CLIPS ("sec" is the source video length; respect the USER RULES above when choosing):
${JSON.stringify(poolForPrompt.map(compact))}

Choose exactly ${numCuts} unique clip ids, one per position. Use the folder names and filenames to judge what each shot shows.
Return ONLY JSON: {"clips":[{"position":1,"id":"c12","role":"hook"}]}  ("role" is one or two words.)`;

  const finalMaxTokens = Math.min(8192, 2500 + numCuts * 45);
  let parsed: { clips?: any[] } = {};
  let finalPrompt = buildFinalPrompt(finalPool);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      parsed = await groqJson("final sequence", SYSTEM_PROMPT, finalPrompt, { maxTokens: finalMaxTokens, temperature: avoidOrderClipIds?.length ? 0.9 : 0.7 });
      break;
    } catch (e) {
      const message = (e as Error).message;
      if (attempt === 0 && /\b413\b|request too large|tokens per minute/i.test(message) && finalPool.length > numCuts * 2) {
        // The request was too big for the account's per-minute token limit: retry with the best 60%, still folder-diverse.
        finalPool = finalPool.slice(0, Math.max(numCuts * 2, Math.ceil(finalPool.length * 0.6)));
        finalPrompt = buildFinalPrompt(finalPool);
        continue;
      }
      // A bad LLM moment must not lose the generation: the constraint-safe filler below still builds a valid sequence.
      console.error("[generate] final call failed:", message);
      warning = `AI sequencing was unavailable (${message.slice(0, 300)}). A locally ranked, constraint-safe sequence was used instead. Press Generate again to retry the AI.`;
      break;
    }
  }
  if (!Array.isArray(parsed?.clips)) parsed = { clips: [] };
  if (process.env.VEYNLOR_DEBUG_PROMPTS === "1") console.log("[generate] FINAL PROMPT\n" + SYSTEM_PROMPT + "\n----\n" + finalPrompt + "\n[generate] RAW MODEL PICKS " + JSON.stringify(parsed.clips));

  // -------------------------------------------------------------------------
  // 5. Validate Groq's answer, fill gaps, enforce order rules
  // -------------------------------------------------------------------------
  const allowedById = new Map(pool.map((clip) => [clip.id, clip]));      // everything the constraints allow
  const lockedClipsById = new Map(taxonomyClips.filter((clip) => lockedIds.has(clip.id)).map((clip) => [clip.id, clip]));
  const slots: (Clip | null)[] = Array.from({ length: numCuts }, () => null);
  const roles: (string | undefined)[] = Array.from({ length: numCuts }, () => undefined);
  const isLockedSlot: boolean[] = Array.from({ length: numCuts }, () => false);
  const used = new Set<string>();
  const fits = (clip: Clip, position: number) => {
    const need = Number(segmentDurations[position - 1] ?? 0);
    return !clip.duration || Number(clip.duration) + 0.01 >= need;
  };

  for (const lock of locked ?? []) {
    const clip = lockedClipsById.get(lock.clip_id);
    if (!clip || lock.position < 1 || lock.position > numCuts || used.has(clip.id)) continue;
    slots[lock.position - 1] = clip; roles[lock.position - 1] = lock.role; isLockedSlot[lock.position - 1] = true; used.add(clip.id);
  }
  const picks = (parsed.clips as any[]).map((item, index) => ({ position: Number(item?.position ?? index + 1), id: String(item?.id ?? item?.clip_id ?? ""), role: typeof item?.role === "string" ? item.role : undefined }))
    .sort((a, b) => a.position - b.position);
  let rejectedPicks = 0;
  for (const pick of picks) {
    // The id is authoritative. A wrong/miscased "category" echoed by the model no longer discards a valid pick.
    const clip = clipByCode.get(pick.id) ?? allowedById.get(pick.id);
    if (!clip || !allowedById.has(clip.id) && !lockedClipsById.has(clip.id)) { rejectedPicks++; continue; }
    if (!Number.isInteger(pick.position) || pick.position < 1 || pick.position > numCuts || slots[pick.position - 1] || used.has(clip.id) || !fits(clip, pick.position)) { rejectedPicks++; continue; }
    slots[pick.position - 1] = clip; roles[pick.position - 1] = pick.role; used.add(clip.id);
  }

  const neighbourCategories = (index: number) => [slots[index - 1], slots[index + 1]].filter(Boolean) as Clip[];
  const fallbackPositions: number[] = [];
  for (let index = 0; index < numCuts; index++) {
    if (slots[index]) continue;
    const neighbours = neighbourCategories(index);
    const candidates = diverse.filter((clip) => !used.has(clip.id) && fits(clip, index + 1) && (enforce || !flagged(clip)));
    const varied = candidates.find((clip) => !neighbours.some((n) => sameCategory(n, clip)));
    const pick = varied ?? candidates[0];
    if (!pick) break;
    slots[index] = pick; roles[index] = "fill"; used.add(pick.id); fallbackPositions.push(index + 1);
  }
  if (slots.some((slot) => !slot)) throw new Error("Could not create a complete sequence: not enough allowed clips are long enough for the beat grid.");

  // Hard order rule: never the same folder twice in a row. Try swaps first (keeps Groq's clip choice), then replacement.
  let remainingRepeats = 0;
  if (enforce && constraints.noAdjacentSameCategory) {
    const clash = (i: number, clip: Clip | null) => Boolean(clip) && ((i > 0 && sameCategory(slots[i - 1] as Clip, clip as Clip)) || (i < numCuts - 1 && sameCategory(slots[i + 1] as Clip, clip as Clip)));
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (let i = 1; i < numCuts; i++) {
        if (!sameCategory(slots[i] as Clip, slots[i - 1] as Clip)) continue;
        const target = isLockedSlot[i] ? (isLockedSlot[i - 1] ? -1 : i - 1) : i;
        if (target < 0) continue;
        const current = slots[target] as Clip;
        let fixed = false;
        for (let j = 0; j < numCuts && !fixed; j++) {
          if (j === target || isLockedSlot[j]) continue;
          const other = slots[j] as Clip;
          if (!fits(other, target + 1) || !fits(current, j + 1)) continue;
          slots[target] = other; slots[j] = current;
          if (!clash(target, other) && !clash(j, current)) { const r = roles[target]; roles[target] = roles[j]; roles[j] = r; fixed = true; changed = true; }
          else { slots[target] = current; slots[j] = other; }
        }
        if (!fixed) {
          const replacement = diverse.find((clip) => !used.has(clip.id) && fits(clip, target + 1) && !clash(target, clip));
          if (replacement) { used.delete(current.id); used.add(replacement.id); slots[target] = replacement; roles[target] = "fill"; if (!fallbackPositions.includes(target + 1)) fallbackPositions.push(target + 1); changed = true; }
        }
      }
      if (!changed) break;
    }
    for (let i = 1; i < numCuts; i++) if (sameCategory(slots[i] as Clip, slots[i - 1] as Clip)) remainingRepeats++;
    if (remainingRepeats) warnings.push(`${remainingRepeats} same-folder repeat${remainingRepeats === 1 ? "" : "s"} could not be avoided (locked clips or not enough variety in the allowed library).`);
  }

  if (!enforce) {
    // Groq is in charge, so violations are REPORTED, not silently overridden.
    const broken = slots.map((clip, i) => (clip && flagged(clip) && !isLockedSlot[i] ? i + 1 : 0)).filter(Boolean);
    if (broken.length) warnings.push(`Groq used a clip from an excluded folder/word at position${broken.length === 1 ? "" : "s"} ${broken.join(", ")}. Press Generate again, or set VEYNLOR_ENFORCE_CONSTRAINTS=1 to make exclusions absolute.`);
    if (constraints.noAdjacentSameCategory) {
      const repeats: number[] = [];
      for (let i = 1; i < numCuts; i++) if (sameCategory(slots[i] as Clip, slots[i - 1] as Clip)) repeats.push(i + 1);
      if (repeats.length) warnings.push(`Same-folder clips are back to back at position${repeats.length === 1 ? "" : "s"} ${repeats.join(", ")}.`);
    }
  }
  if (rejectedPicks) console.warn(`[generate] ${rejectedPicks} model pick(s) were rejected (unknown id, duplicate, wrong slot, or too short).`);
  if (fallbackPositions.length) warnings.push(`Position${fallbackPositions.length === 1 ? "" : "s"} ${fallbackPositions.sort((a, b) => a - b).join(", ")} could not be filled by the AI and ${fallbackPositions.length === 1 ? "was" : "were"} filled locally.`);

  const ordered: OrderedClip[] = slots.map((clip, index) => ({ position: index + 1, clip_id: (clip as Clip).id, category: (clip as Clip).category, role: roles[index] }));
  return {
    ordered,
    warning: [warning, ...warnings].filter(Boolean).join(" ") || undefined,
    constraints,
    pool: diverse.filter((clip) => enforce || !flagged(clip)),
    fallbackPositions,
  };
}
