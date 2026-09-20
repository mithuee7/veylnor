"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useSupabaseConfig } from "@/contexts/SupabaseConfigContext";
import { LoadedReference, ReferenceAnalysis } from "@/types";

type ReferenceState = LoadedReference & {
  status: "uploading" | "queued" | "analyzing" | "complete" | "error";
  progress: number;
  stage: string;
  error?: string;
};

const MAX_REFERENCE_REELS = 5;

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) throw new Error(`Server returned an empty response (HTTP ${res.status}).`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Server returned invalid JSON (HTTP ${res.status}).`); }
}

function Progress({ progress, stage }: { progress: number; stage: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return <div className="space-y-1.5" aria-live="polite">
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] text-muted truncate">{stage}</span>
      <span className="text-[11px] font-mono text-goldSoft tabular-nums">{pct}%</span>
    </div>
    <div className="h-1.5 rounded-full bg-panelBorder overflow-hidden">
      <div className="h-full bg-gold transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
    </div>
  </div>;
}

export default function ReferenceReel({
  value,
  onChange,
  onBusyChange,
}: {
  value: LoadedReference[];
  onChange: (value: LoadedReference[]) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { client: supabase } = useSupabaseConfig();
  const [states, setStates] = useState<ReferenceState[]>(value.map(item => ({
    ...item,
    status: "complete",
    progress: 100,
    stage: "Reference analysis complete",
  })));
  const [globalError, setGlobalError] = useState("");

  function sync(next: ReferenceState[]) {
    setStates(next);
    onChange(next.filter(item => item.status === "complete" && item.analysis).map(({ id, path, name, analysis }) => ({ id, path, name, analysis } as LoadedReference)));
  }

  function patch(id: string, update: Partial<ReferenceState>) {
    setStates(current => {
      const next = current.map(item => item.id === id ? { ...item, ...update } : item);
      onChange(next.filter(item => item.status === "complete" && item.analysis).map(({ id: itemId, path, name, analysis }) => ({ id: itemId, path, name, analysis } as LoadedReference)));
      return next;
    });
  }

  async function upload(file: File) {
    if (!supabase) throw new Error("Supabase is not configured.");
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const placeholder: ReferenceState = {
      id,
      path: "",
      name: file.name,
      analysis: null as unknown as ReferenceAnalysis,
      status: "uploading",
      progress: 4,
      stage: "Preparing upload…",
    };
    setStates(current => [...current, placeholder]);
    setGlobalError("");

    try {
      const uploadRes = await fetch("/api/reference/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      const uploadJson = await readJson(uploadRes);
      if (!uploadRes.ok || uploadJson.error) throw new Error(uploadJson.error || "Could not prepare reference upload.");
      patch(id, { status: "uploading", progress: 10, stage: "Uploading reference…", path: uploadJson.path });

      const uploaded = await supabase.storage.from("references").uploadToSignedUrl(uploadJson.path, uploadJson.token, file);
      if (uploaded.error) throw uploaded.error;

      patch(id, { status: "queued", progress: 12, stage: "Queued for local analysis…" });
      const analysisRes = await fetch("/api/reference/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: uploadJson.path }),
      });
      const analysisJson = await readJson(analysisRes);
      if (!analysisRes.ok || analysisJson.error) throw new Error(analysisJson.error || "Could not start reference analysis.");

      const jobId = String(analysisJson.jobId || "");
      if (!jobId) throw new Error("Reference analysis job was not created.");
      patch(id, { status: "analyzing", progress: Number(analysisJson.progress ?? 12), stage: analysisJson.stage || "Analyzing…" });

      let transientFailures = 0;
      const started = Date.now();
      while (Date.now() - started < 20 * 60 * 1000) {
        await new Promise(resolve => setTimeout(resolve, 800));
        try {
          const statusRes = await fetch(`/api/reference/analyze?jobId=${encodeURIComponent(jobId)}&_=${Date.now()}`, { cache: "no-store" });
          const status = await readJson(statusRes);
          if (!statusRes.ok || status.error) throw new Error(status.error || "Could not read reference analysis status.");
          transientFailures = 0;
          patch(id, {
            status: status.status === "complete" ? "complete" : status.status === "failed" ? "error" : status.status,
            progress: Number(status.progress ?? 0),
            stage: status.stage ?? "Analyzing…",
            analysis: status.analysis,
            error: status.error,
          });
          if (status.status === "complete") return;
          if (status.status === "failed") throw new Error(status.error || "Reference analysis failed.");
        } catch (pollError: any) {
          transientFailures += 1;
          if (transientFailures >= 6) throw pollError;
        }
      }
      throw new Error("Reference analysis timed out.");
    } catch (e: any) {
      patch(id, { status: "error", progress: 100, stage: "Analysis failed", error: e?.message ?? "Reference upload failed." });
    }
  }

  async function onFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    if (states.length + files.length > MAX_REFERENCE_REELS) {
      setGlobalError(`You can use up to ${MAX_REFERENCE_REELS} reference reels per generation.`);
      return;
    }
    try {
      for (const file of files) await upload(file);
    } catch (e: any) {
      setGlobalError(e?.message ?? "Could not upload reference reels.");
    }
  }

  function remove(id: string) {
    sync(states.filter(item => item.id !== id));
  }

  const overallProgress = useMemo(() => {
    if (!states.length) return 0;
    return Math.round(states.reduce((sum, item) => sum + item.progress, 0) / states.length);
  }, [states]);
  const busy = states.some(item => item.status === "uploading" || item.status === "queued" || item.status === "analyzing");

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  return <div className="card p-5 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="label">REFERENCE REELS · OPTIONAL</p>
        <p className="text-sm text-muted mt-1 max-w-2xl">Use several references when you want Veylnor to learn a shared editing language. Analysis runs locally with FFmpeg/pixel/audio signals; no frames are sent to a vision API.</p>
      </div>
      <label className={`inline-flex px-4 py-2 rounded border border-panelBorder text-sm text-ink cursor-pointer hover:border-gold ${states.length >= MAX_REFERENCE_REELS ? "opacity-40 pointer-events-none" : ""}`}>
        + Add reference reel{states.length ? "s" : ""}
        <input type="file" accept="video/*" multiple className="hidden" onChange={onFiles} />
      </label>
    </div>

    {states.length > 0 && <div className="space-y-2">
      <Progress progress={overallProgress} stage={`${states.filter(item => item.status === "complete").length}/${states.length} reference${states.length === 1 ? "" : "s"} analyzed`} />
    </div>}

    {!states.length && <div className="rounded border border-dashed border-panelBorder px-4 py-6 text-center">
      <p className="text-sm text-ink">No reference reels added</p>
      <p className="text-xs text-muted mt-1">Add one or several reels to guide pacing, composition, motion and payoff.</p>
    </div>}

    <div className="space-y-3">
      {states.map(item => <div key={item.id} className="rounded border border-panelBorder/80 bg-black/10 p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-ink truncate">{item.name}</p>
            {item.status === "complete" && item.analysis && <p className="text-xs text-muted mt-1">{item.analysis.cutCount} shots · avg {item.analysis.averageCutDuration.toFixed(2)}s · hook {item.analysis.hookDuration?.toFixed(2)}s · {item.analysis.beatSync.filter(x => x.aligned).length}/{item.analysis.beatSync.length} beat-aligned</p>}
            {item.status === "error" && <p className="text-xs text-red-400 mt-1">{item.error}</p>}
          </div>
          <button onClick={() => remove(item.id)} className="text-xs text-muted hover:text-red-400 shrink-0">Remove</button>
        </div>
        {item.status !== "complete" && <Progress progress={item.progress} stage={item.stage} />}
      </div>)}
    </div>

    {globalError && <p className="text-xs text-red-400">{globalError}</p>}
  </div>;
}
