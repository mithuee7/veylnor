import "server-only";
import { Clip, BeatInfo, OrderedClip, ReferenceAnalysis } from "@/types";
import { getMusicCompatibleClips, parseClipMetadata, scoreClipForGeneration } from "@/lib/music-compatibility";
import { applyInstructionRules } from "@/lib/instruction-rules";

const SYSTEM_PROMPT = `You are the sequencing director for Veylnor, a general-purpose short-form video editor.
Choose a creative sequence from the supplied clips.

Priority order:
1. The user's Reel Style Instructions and explicit scene requirements.
2. The selected song section, beat grid, and music energy.
3. Folder/category subject context.
4. Intentional filename metadata describing visual characteristics.
5. Optional reference-reel editing language as secondary guidance only.

Create a strong hook, purposeful pacing, visual variety, escalation where appropriate, and a satisfying ending. Match visual energy to the music unless the user's instructions say otherwise. Use filename tags such as fast, fast-paced, slow, slow-paced, high-energy, low-energy, dynamic, static, driving, aerial, close-up, wide, night, interior, exterior, cinematic, etc. as metadata. The folder/category tells you the primary subject/context. Never invent unsupported attributes, never repeat a clip, and never force a category unless the user asks for it. Segment durations are authoritative; do not invent arbitrary durations.

If a reference blueprint is supplied, use it only to understand broad editing language such as rhythm, composition variety, movement patterns, hook structure, and payoff shape. Never copy its footage, people, or exact sequence.`

interface GenerateArgs {
  clips: Clip[];
  beatInfo: BeatInfo;
  references?: ReferenceAnalysis[] | null;
  reelInstructions?: string;
  locked?: OrderedClip[];
  avoidOrderClipIds?: string[][];
  availableCategories: string[];
}

type CompactReferenceFingerprint = {
  hookStructure?: { compositions?: string[]; motion?: string[]; cameraMovement?: string[]; durations?: number[] };
  repetitionPatterns?: { motionSequence?: string[]; cameraSequence?: string[]; toneSequence?: string[] };
  compositionPattern?: { sequence?: string[]; variety?: number | null };
  beatSync?: { alignedCutRatio?: number | null; cutOffsets?: Array<number | null> };
  endingPayoff?: { compositions?: string[]; motion?: string[]; visualImpact?: number[]; strongestShot?: number | null };
};

function compactClipMetadata(clip: Clip) {
  const metadata = parseClipMetadata(clip);
  return {
    id: clip.id,
    filename: clip.filename,
    category: clip.category,
    duration: clip.duration == null ? null : Number(Number(clip.duration).toFixed(1)),
    metadata: { tags: metadata.tags.slice(0, 16), energy: metadata.energy, pace: metadata.pace, motion: metadata.motion },
  };
}

export async function generateSequence({ clips, beatInfo, references, reelInstructions, locked, avoidOrderClipIds, availableCategories }: GenerateArgs) {
  const segmentDurations = beatInfo.segmentDurations.map(Number);
  const categorySet = new Set(availableCategories.map((category) => category.trim()).filter(Boolean));
  const taxonomyClips = clips.filter((c) => categorySet.has(c.category.trim()));
  const lockedIds = new Set((locked ?? []).map((item) => item.clip_id));
  // Hard rules from the user's instructions ("avoid jets", "make it energetic") are enforced here,
  // in code, by shrinking the pool BEFORE the model sees anything. The model cannot pick what it is never shown.
  const rules = applyInstructionRules(taxonomyClips, reelInstructions ?? "", availableCategories, lockedIds, beatInfo.numCuts);
  if (rules.error) throw new Error(rules.error);
  const excludedCategoryNames = new Set(rules.excludedCategories);
  const visibleCategories = availableCategories.filter((name) => !excludedCategoryNames.has(name.trim().toLowerCase()));
  const compatibility = getMusicCompatibleClips(rules.clips, beatInfo);
  const lockedClips = rules.clips.filter((clip) => lockedIds.has(clip.id));
  const usableClips = Array.from(new Map([...compatibility.clips, ...lockedClips].map((clip) => [clip.id, clip])).values());
  const numCuts = beatInfo.numCuts;
  if (usableClips.length < numCuts) throw new Error(`This beat grid needs ${numCuts} unique clips, but only ${usableClips.length} clips are available. Add more clips or use a shorter song section.`);

  // Rank the full library locally instead of exposing an arbitrary first-N slice.
  // The model receives the most relevant candidates plus every locked clip.
  const maxNeededDuration = Math.max(...segmentDurations, 0);
  const rankedClips = [...usableClips].sort((a, b) => {
    const aDuration = Number(a.duration ?? 0) + 0.01 >= maxNeededDuration ? 2 : 0;
    const bDuration = Number(b.duration ?? 0) + 0.01 >= maxNeededDuration ? 2 : 0;
    const diff = (scoreClipForGeneration(b, compatibility.band, reelInstructions ?? "") + bDuration) - (scoreClipForGeneration(a, compatibility.band, reelInstructions ?? "") + aDuration);
    return diff || String(a.id).localeCompare(String(b.id));
  });
  const selectedManifestClips: Clip[] = [];
  const maxManifestChars = 15000;
  let selectedManifestChars = 2;
  for (const clip of rankedClips) {
    const compact = compactClipMetadata(clip);
    const size = JSON.stringify(compact).length + 1;
    if (selectedManifestClips.length >= numCuts + 12 && selectedManifestChars + size > maxManifestChars) break;
    if (selectedManifestChars + size > maxManifestChars) continue;
    selectedManifestClips.push(clip);
    selectedManifestChars += size;
  }
  for (const clip of lockedClips) if (!selectedManifestClips.some((x) => x.id === clip.id)) selectedManifestClips.push(clip);
  const manifest = selectedManifestClips.map(compactClipMetadata);

  const musicText = {
    bpm: beatInfo.bpm,
    energy: beatInfo.musicProfile?.energy ?? null,
    dynamics: beatInfo.musicProfile?.dynamics ?? null,
    brightness: beatInfo.musicProfile?.brightness ?? null,
    descriptors: beatInfo.musicProfile?.descriptors ?? [],
    energyBand: compatibility.band,
  };

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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");

  const baseContext = `CLIP METADATA RULES:
- Treat each folder/category as the clip's primary subject/context (for example, cars, jets, travel, women, etc.).
- Treat descriptive parts of each filename as intentional metadata. Parse hyphen/underscore/space-separated tags such as fast, fast-paced, slow-paced, high-energy, low-energy, dynamic, static, cinematic, driving, walking, aerial, close-up, wide, night, interior, exterior, etc.
- Match filename metadata to the desired scene, saved Reel Style Instructions, and selected music. Prefer clips whose subject and visual attributes jointly satisfy the scene.
- Avoid repeatedly choosing clips with the same visual attributes when alternatives exist.

MUSIC:
BPM ${beatInfo.bpm}; selected section ${beatInfo.windowStart}s-${beatInfo.windowEnd}s; total ${beatInfo.duration}s.
Music profile: ${JSON.stringify(musicText)}
Music compatibility band: ${compatibility.band}
Segment durations: ${JSON.stringify(beatInfo.segmentDurations)}
Beat density: ${beatInfo.clipsPerBeat} clip(s) per beat.

REFERENCE BLUEPRINTS (secondary guidance only):
${JSON.stringify(referenceText)}
Reference rules: use references only for broad editing language. User Reel Style Instructions, actual scene requirements, music, folders, and filename metadata take precedence. Never copy footage, faces, or an exact sequence.

REEL STYLE INSTRUCTIONS (high priority):
${(reelInstructions?.trim() || "No saved Reel Style Instructions.").slice(0, 1800)}

LOCKED POSITIONS:
${JSON.stringify((locked ?? []).slice(0, 24))}

AVAILABLE CATEGORIES:
${JSON.stringify(visibleCategories)}

HARD RULES (already enforced in code; every clip you are shown complies): ${rules.notes.join(" ") || "none"}

The final reel needs exactly ${numCuts} unique clips. Locked positions must be preserved. Segment durations are authoritative.`;

  const previousOrdersText = avoidOrderClipIds?.length
    ? `\nPrevious orders to avoid (truncated):\n${JSON.stringify(avoidOrderClipIds.slice(0, 2).map(order => order.slice(0, Math.min(order.length, numCuts, 18))))}`
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

  // ---------------------------------------------------------------------------
  // Candidate selection
  // ---------------------------------------------------------------------------
  // Small libraries: send everything to the final call in ONE request.
  // Big libraries: ask Groq for the best candidates per batch first. Each batch
  // is best-effort; a failed batch never blocks generation.
  const allManifest = usableClips.map(compactClipMetadata);
  const allManifestChars = JSON.stringify(allManifest).length;
  const SINGLE_PASS_MAX_CHARS = 14000;
  const needsCandidatePass = allManifestChars > SINGLE_PASS_MAX_CHARS;
  let warning: string | undefined;

  const candidateIds = new Set<string>();
  if (needsCandidatePass) {
    const batchCount = Math.max(2, Math.min(5, Math.ceil(allManifestChars / 9000)));
    const batchSize = Math.ceil(allManifest.length / batchCount);
    const manifests: Array<typeof allManifest> = [];
    for (let i = 0; i < batchCount; i++) {
      const part = allManifest.slice(i * batchSize, (i + 1) * batchSize);
      if (part.length) manifests.push(part); // never send an empty batch
    }

    const candidateContext = `MUSIC: BPM ${beatInfo.bpm}; energy=${beatInfo.musicProfile?.energy ?? "unknown"}; band=${compatibility.band}.
SEGMENT DURATIONS: ${JSON.stringify(beatInfo.segmentDurations)}
REEL STYLE INSTRUCTIONS: ${(reelInstructions?.trim() || "None").slice(0, 1200)}
CATEGORIES: ${JSON.stringify(visibleCategories)}`;

    const perBatch = Math.min(Math.max(numCuts * 2, 8), 16);
    let failedBatches = 0;
    for (let i = 0; i < manifests.length; i++) {
      const prompt = `${candidateContext}

CANDIDATE BATCH ${i + 1}/${manifests.length}:
${JSON.stringify(manifests[i])}

From ONLY this batch, pick the strongest candidates for the reel. Use folder/category as subject context and filename metadata as visual metadata. Match energy/pacing to the music and saved instructions. Return up to ${perBatch} candidates, best first, fit 1-100. Do not invent clip IDs.
Return ONLY JSON: {"candidates":[{"clip_id":"...","category":"...","fit":90}]}`;
      try {
        const result = await groqJson(
          `candidate batch ${i + 1}`,
          "You are Veylnor's clip-candidate selector. Be concise. Use only supplied clip IDs and metadata.",
          prompt,
          { maxTokens: 2048 + perBatch * 40, temperature: 0.5 },
        );
        if (Array.isArray(result.candidates)) for (const c of result.candidates) if (c?.clip_id) candidateIds.add(String(c.clip_id));
      } catch (e) {
        failedBatches++;
        console.error("[generate] candidate batch failed:", (e as Error).message);
      }
      if (i < manifests.length - 1) await sleep(1200);
    }
    if (failedBatches) warning = `${failedBatches} of ${manifests.length} AI candidate passes failed, so part of the library was ranked locally instead.`;
  }
  for (const clip of lockedClips) candidateIds.add(clip.id);
  // Keep only IDs that really exist, then top up with the local ranking so the pool is never too thin.
  const knownIds = new Set(usableClips.map(c => c.id));
  for (const id of Array.from(candidateIds)) if (!knownIds.has(id)) candidateIds.delete(id);
  if (!needsCandidatePass) for (const clip of usableClips) candidateIds.add(clip.id);
  else if (candidateIds.size < numCuts + 4) {
    for (const clip of rankedClips.slice(0, Math.max(numCuts + 8, 24))) candidateIds.add(clip.id);
  }
  const candidateManifest = allManifest.filter(x => candidateIds.has(x.id));

  // ---------------------------------------------------------------------------
  // Final sequencing call
  // ---------------------------------------------------------------------------
  const candidatePrompt = `${baseContext}${previousOrdersText}

${needsCandidatePass ? "FINAL CANDIDATE POOL (pre-selected by independent metadata passes)" : "AVAILABLE CLIPS"}:
${JSON.stringify(candidateManifest)}

Choose exactly ${numCuts} unique clip IDs from this pool. Preserve locked positions. Match each clip to its position's duration and scene role. Return categories using the exact category value from the manifest. Keep "role" to one or two words and "visual_energy" to low, medium or high.
Return ONLY JSON:
{"clips":[{"position":1,"clip_id":"...","category":"...","role":"hook","visual_energy":"high"}, ...]}`;

  // ~45 visible tokens per clip object + generous headroom for hidden reasoning.
  const finalMaxTokens = Math.min(8192, 2500 + numCuts * 45);
  let parsed: { clips: OrderedClip[] } = { clips: [] };
  try {
    parsed = await groqJson("final sequence", SYSTEM_PROMPT, candidatePrompt, {
      maxTokens: finalMaxTokens,
      temperature: avoidOrderClipIds?.length ? 0.9 : 0.7,
    });
  } catch (e) {
    // Do not lose the whole generation because the LLM had a bad moment.
    // The deterministic fill below builds a valid, duration-safe sequence.
    console.error("[generate] final call failed:", (e as Error).message);
    warning = `AI sequencing was unavailable (${(e as Error).message.slice(0, 300)}). A locally ranked sequence was used instead — press Generate again to retry the AI.`;
  }
  if (!Array.isArray(parsed?.clips)) parsed = { clips: [] };

  const valid = new Map(usableClips.filter((u) => candidateIds.has(u.id)).map((u) => [u.id, u]));
  const allValid = new Map(usableClips.map((c) => [c.id, c]));
  const lockedMap = new Map((locked ?? []).map((x) => [x.position, x]));
  const result: OrderedClip[] = [];
  const used = new Set<string>();

  function fitsPosition(clipId: string, pos: number) {
    const clip = allValid.get(clipId);
    const need = Number(segmentDurations[pos - 1] ?? 0);
    return Boolean(clip && (Number(clip.duration ?? 0) + 0.01 >= need || !clip.duration));
  }

  for (let pos = 1; pos <= numCuts; pos++) {
    const lock = lockedMap.get(pos);
    const preferred = lock ? [lock] : (parsed.clips ?? []).filter((x) => x.position === pos);
    const candidate = preferred.find((x) => {
      if (!valid.has(x.clip_id) || used.has(x.clip_id) || !fitsPosition(x.clip_id, pos)) return false;
      const clip = valid.get(x.clip_id)!;
      const requestedCategory = String(x.category ?? "").trim();
      return !requestedCategory || (categorySet.has(requestedCategory) && requestedCategory === clip.category);
    });
    if (!candidate) continue;
    used.add(candidate.clip_id);
    const clip = valid.get(candidate.clip_id)!;
    result.push({ position: pos, clip_id: clip.id, category: clip.category, role: candidate.role });
  }

  for (let pos = 1; pos <= numCuts; pos++) {
    if (result.some((x) => x.position === pos)) continue;
    const fallbackPool = [...rankedClips.filter((clip) => candidateIds.has(clip.id)), ...rankedClips.filter((clip) => !candidateIds.has(clip.id))];
    const fallback = fallbackPool.find((c) => !used.has(c.id) && fitsPosition(c.id, pos));
    if (!fallback) break;
    used.add(fallback.id);
    result.push({ position: pos, clip_id: fallback.id, category: fallback.category, role: "transition" });
  }
  result.sort((a,b) => a.position-b.position).forEach((x,i) => x.position=i+1);
  if (result.length !== numCuts) throw new Error("Could not create a complete sequence.");
  const allNotes = [warning, ...rules.notes].filter(Boolean).join(" ");
  return { ordered: result, warning: allNotes || undefined };
}
