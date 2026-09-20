import "server-only";
import { supabaseServer } from "@/lib/supabase-server";
import { generateSequence } from "@/lib/generate";
import { sameCategory } from "@/lib/instruction-constraints";
import { selectShotWindow, ShotSelection } from "@/lib/stable-source";
import { BeatInfo, Clip, OrderedClip, ReferenceAnalysis, SequenceItem } from "@/types";

/**
 * THE one production clip-selection pipeline.
 *
 *   Supabase clips + instructions + song grid
 *     -> hard constraints (code)            [lib/instruction-constraints.ts]
 *     -> Groq picks which video per slot    [lib/generate.ts]
 *     -> validation / variety repair        [lib/generate.ts]
 *     -> FFmpeg picks a cut-free section    [lib/stable-source.ts]
 *     -> SequenceItem[] (sourceStart/sourceEnd)  -> renderer
 *
 * /api/generate (web UI) and /api/v1/reels (n8n API) both call buildReelSequence(), and nothing else.
 */

export interface BuildSequenceArgs {
  clips: Clip[];
  availableCategories: string[];
  beatInfo: BeatInfo;
  references?: ReferenceAnalysis[] | null;
  reelInstructions?: string;
  locked?: (OrderedClip & { sourceStart?: number; sourceEnd?: number })[];
  avoidOrderClipIds?: string[][];
}

export interface BuildSequenceResult {
  items: SequenceItem[];
  warning?: string;
  /** Human-readable list of the hard constraints that were applied. */
  constraintNotes: string[];
}

async function signClip(clip: Clip): Promise<string | null> {
  const signed = await supabaseServer.storage.from("clips").createSignedUrl(clip.storage_path, 60 * 60);
  return signed.data?.signedUrl ?? null;
}

export async function buildReelSequence(args: BuildSequenceArgs): Promise<BuildSequenceResult> {
  const { clips, beatInfo, locked } = args;
  const gen = await generateSequence({
    clips, beatInfo, references: args.references, reelInstructions: args.reelInstructions,
    locked, avoidOrderClipIds: args.avoidOrderClipIds, availableCategories: args.availableCategories,
  });
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const warnings: string[] = gen.warning ? [gen.warning] : [];
  const targets = gen.ordered.map((_, index) => Number(beatInfo.segmentDurations[index] ?? 0.5));

  interface Slot { position: number; clip: Clip; role?: string; url: string | null; manual?: { start: number; end: number }; selection?: ShotSelection; swappedFrom?: string }
  const slots: Slot[] = await Promise.all(gen.ordered.map(async (item, index) => {
    const clip = clipsById.get(item.clip_id);
    if (!clip) throw new Error(`Generated clip ${item.clip_id} no longer exists.`);
    const target = targets[index];
    const sourceDuration = Number(clip.duration ?? target);
    const lock = locked?.find((x) => x.position === index + 1 && x.clip_id === clip.id);
    const slot: Slot = { position: index + 1, clip, role: item.role, url: await signClip(clip) };
    // Locked/manual source sections are authoritative and never replaced by auto-selection.
    if (lock?.sourceStart !== undefined) {
      const start = Math.max(0, Math.min(Number(lock.sourceStart), Math.max(0, sourceDuration - target)));
      slot.manual = { start, end: sourceDuration >= target ? start + target : sourceDuration };
    }
    return slot;
  }));

  const analyse = async (slot: Slot, clip: Clip, url: string | null) => {
    const target = targets[slot.position - 1];
    if (!url) return { start: 0, end: target, shotStart: 0, shotEnd: target, shotCount: 0, status: "unverified", note: "Clip URL unavailable; section not verified." } as ShotSelection;
    return selectShotWindow({ cacheKey: clip.id, url, target, sourceDuration: clip.duration });
  };

  // Pass 1: shot analysis for every automatically chosen clip (2 at a time to stay inside the 512 MB instance).
  const auto = slots.filter((slot) => !slot.manual);
  for (let offset = 0; offset < auto.length; offset += 2) {
    await Promise.all(auto.slice(offset, offset + 2).map(async (slot) => { slot.selection = await analyse(slot, slot.clip, slot.url); }));
  }

  // Pass 2: a chosen video without ANY cut-free shot long enough for its slot is swapped for the next best allowed
  // clip that has one. Shots are never combined; if nothing better exists the short single shot is kept and reported.
  const usedIds = new Set(slots.map((slot) => slot.clip.id));
  let swaps = 0;
  const swappedPositions: number[] = [];
  // BUG FIX: "unverified" used to be excluded from this swap pass entirely. When FFmpeg scene detection fails for
  // a clip, getShotMap has zero real cut data for it, so pickWindow's "chosen" shot is really just the WHOLE clip
  // treated as one fake shot -- there is no way to know a real cut isn't hiding inside the extracted window. The
  // old code accepted that blind guess and rendered it (only warning afterward), which is precisely the kind of
  // "cuts slip through" bug reported: it happened on whichever clip hit a transient detection failure (network
  // hiccup, or the 60s FFmpeg timeout on this project's 512MB instance), not on every clip, so it looked random.
  // Fix: treat "unverified" exactly like "no qualifying shot" and try other pool clips until one comes back "ok"
  // (i.e. detection succeeded AND it has a real cut-free shot long enough). Only if every alternate also fails to
  // verify do we fall back to the original clip's best-effort guess, same as before -- but now that is a last
  // resort instead of the first response to a transient failure.
  const swappedForUnverified: number[] = [];
  for (const slot of auto) {
    const status = slot.selection?.status;
    const reasonIsUnverified = status === "unverified";
    if (status !== "short-shot" && status !== "clip-too-short" && !reasonIsUnverified) continue;
    const target = targets[slot.position - 1];
    const neighbours = () => [slots[slot.position - 2]?.clip, slots[slot.position]?.clip].filter(Boolean) as Clip[];
    const alternates = gen.pool.filter((clip) => !usedIds.has(clip.id) && (!clip.duration || Number(clip.duration) + 0.01 >= target)
      && (!gen.constraints.noAdjacentSameCategory || !neighbours().some((n) => sameCategory(n, clip))));
    let tries = 0;
    for (const alt of alternates) {
      if (tries++ >= 4) break;
      const url = await signClip(alt);
      const selection = await analyse(slot, alt, url);
      if (selection.status === "ok") {
        usedIds.delete(slot.clip.id); usedIds.add(alt.id);
        slot.swappedFrom = slot.clip.filename;
        slot.clip = alt; slot.url = url; slot.selection = selection; swaps++;
        const reason = reasonIsUnverified ? "could not be scene-checked (detection failed)" : `has no uninterrupted ${target.toFixed(2)}s shot`;
        console.log(`[pipeline] position ${slot.position}: "${slot.swappedFrom}" ${reason}; swapped for "${alt.filename}".`);
        swappedPositions.push(slot.position);
        if (reasonIsUnverified) swappedForUnverified.push(slot.position);
        break;
      }
    }
  }

  const shortSwaps = swappedPositions.filter((p) => !swappedForUnverified.includes(p));
  if (shortSwaps.length) warnings.push(`Position${shortSwaps.length === 1 ? "" : "s"} ${shortSwaps.sort((a, b) => a - b).join(", ")}: the AI's clip had no uninterrupted shot long enough for its slot, so the next best allowed clip with one was used.`);
  if (swappedForUnverified.length) warnings.push(`Position${swappedForUnverified.length === 1 ? "" : "s"} ${swappedForUnverified.sort((a, b) => a - b).join(", ")}: scene detection failed on the AI's clip, so a clip that could be verified cut-free was used instead.`);
  const shortSlots = auto.filter((slot) => slot.selection?.status === "short-shot" || slot.selection?.status === "clip-too-short");
  if (shortSlots.length) warnings.push(`Position${shortSlots.length === 1 ? "" : "s"} ${shortSlots.map((s) => s.position).join(", ")}: no cut-free shot long enough exists in the chosen or alternative clips; the longest single shot is used and its last frame is held (shots are never combined).`);
  const unverified = auto.filter((slot) => slot.selection?.status === "unverified");
  if (unverified.length) warnings.push(`Scene detection was unavailable for position${unverified.length === 1 ? "" : "s"} ${unverified.map((s) => s.position).join(", ")} even after trying alternate clips; that section could not be checked for cuts.`);

  const items: SequenceItem[] = slots.map((slot) => {
    const target = targets[slot.position - 1];
    const base = { position: slot.position, category: slot.clip.category, role: slot.role, clip: { ...slot.clip, url: slot.url }, targetDuration: target };
    if (slot.manual) {
      return { ...base, sourceStart: Number(slot.manual.start.toFixed(3)), sourceEnd: Number(slot.manual.end.toFixed(3)), locked: true };
    }
    const sel = slot.selection!;
    return {
      ...base,
      sourceStart: sel.start,
      sourceEnd: sel.end,
      locked: false,
      shot: { status: sel.status, shotStart: sel.shotStart, shotEnd: sel.shotEnd, note: sel.note },
      shortShot: sel.end - sel.start + 0.03 < target,
    };
  });
  if (swaps) console.log(`[pipeline] ${swaps} slot(s) swapped because no cut-free shot fit.`);
  return { items, warning: warnings.join(" ") || undefined, constraintNotes: gen.constraints.notes };
}
