"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SequenceItem } from "@/types";

function fmt(n: number) { return `${Math.max(0, Number.isFinite(n) ? n : 0).toFixed(3)}s`; }

export default function ClipTrimModal({ item, onConfirm, onClose }: {
  item: SequenceItem;
  onConfirm: (start:number,end:number)=>void;
  onClose: ()=>void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const duration = Number(item.clip.duration ?? 0);
  const targetDuration = Number(item.targetDuration);
  const maxStart = Math.max(0, duration - targetDuration);
  const [start,setStart] = useState(Math.min(item.sourceStart, maxStart));
  const [playing,setPlaying] = useState(false);
  const [mode,setMode] = useState<"whole"|"selected">("selected");
  const [current,setCurrent] = useState(Math.min(item.sourceStart, maxStart));

  const end = useMemo(() => Math.min(duration, start + targetDuration), [start, duration, targetDuration]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.currentTime = start;
  }, [start]);

  function playSelected() {
    const v=videoRef.current; if(!v) return;
    v.currentTime=start;
    setCurrent(start);
    setMode("selected");
    setPlaying(true);
    void v.play();
  }

  function playWhole() {
    const v=videoRef.current; if(!v) return;
    setMode("whole");
    setPlaying(true);
    void v.play();
  }

  function pause() {
    videoRef.current?.pause();
    setPlaying(false);
  }

  function setStartSafe(n:number) {
    const next = Math.max(0, Math.min(Number.isFinite(n) ? n : 0, maxStart));
    setStart(next);
    setCurrent(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  }

  function handleTimeUpdate() {
    const v = videoRef.current;
    if (!v) return;
    setCurrent(v.currentTime);
    if (mode === "selected" && v.currentTime >= end - 0.01) {
      v.pause();
      v.currentTime = end;
      setCurrent(end);
      setPlaying(false);
    }
  }

  return <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4">
    <div className="card w-full max-w-xl max-h-[92vh] overflow-y-auto p-4 sm:p-5 space-y-4">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg sm:text-xl text-ink truncate">{item.clip.filename}</p>
          <p className="text-xs text-muted capitalize">{item.category} · Fixed slot {fmt(targetDuration)}</p>
        </div>
        <button onClick={onClose} className="text-muted hover:text-ink shrink-0" aria-label="Close">✕</button>
      </div>

      <div className="aspect-video bg-black rounded overflow-hidden">
        {item.clip.url && <video ref={videoRef} src={item.clip.url} muted playsInline preload="metadata" className="w-full h-full object-contain" onTimeUpdate={handleTimeUpdate} onEnded={()=>setPlaying(false)}/>}      
      </div>

      <div className="flex items-center gap-2">
        <button onClick={playing ? pause : (mode === "whole" ? playWhole : playSelected)} className="w-10 h-10 rounded-full border border-gold text-goldSoft hover:bg-gold/10">{playing ? "Ⅱ" : "▶"}</button>
        <input aria-label="Video position" type="range" min="0" max={duration || 0.01} step="0.001" value={Math.min(duration || 0.01, current)} onChange={e => { const n=Number(e.target.value); setCurrent(n); if(videoRef.current) videoRef.current.currentTime=n; }} className="range flex-1"/>
        <span className="text-[11px] font-mono text-muted tabular-nums">{fmt(current)}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={playWhole} className={`px-3 py-2 rounded border text-sm ${mode === "whole" && playing ? "border-gold text-goldSoft" : "border-panelBorder text-ink hover:border-gold"}`}>Play whole video</button>
        <button onClick={playSelected} className={`px-3 py-2 rounded border text-sm ${mode === "selected" && playing ? "border-gold text-goldSoft" : "border-panelBorder text-ink hover:border-gold"}`}>Play selected part</button>
        <button onClick={() => setStartSafe(0)} className="px-3 py-2 rounded border border-panelBorder text-sm text-ink hover:border-gold">Use beginning</button>
      </div>

      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:justify-between gap-1 text-xs">
          <span className="text-muted">Choose which part of the source fills this slot</span>
          <span className="font-mono text-goldSoft">Source {fmt(start)} → {fmt(end)} · keeps {fmt(targetDuration)}</span>
        </div>
        <div className="relative h-12 bg-base border border-panelBorder rounded">
          <div className="absolute top-0 bottom-0 bg-gold/20 border-x-2 border-goldSoft" style={{left:`${duration ? (start/duration)*100 : 0}%`,width:`${duration ? (targetDuration/duration)*100 : 0}%`}}/>
          <input aria-label="Clip source position" type="range" min="0" max={maxStart} step="0.001" value={start} onChange={e=>setStartSafe(Number(e.target.value))} className="range absolute inset-0 w-full"/>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-muted">Source start<input type="number" min="0" max={maxStart} step=".001" value={start} onChange={e=>setStartSafe(Number(e.target.value))} className="block mt-1 w-full bg-base border border-panelBorder rounded px-3 py-2 text-sm"/></label>
          <div className="text-xs text-muted">Source end<div className="mt-1 w-full bg-base border border-panelBorder rounded px-3 py-2 text-sm font-mono text-ink">{end.toFixed(3)}</div></div>
        </div>
        {duration < targetDuration && <p className="text-xs text-red-300">This source clip is shorter than the required slot. Choose another clip during regeneration.</p>}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onClose} className="px-4 py-2 rounded border border-panelBorder text-sm text-ink">Cancel</button>
        <button onClick={()=>onConfirm(start,end)} disabled={duration < targetDuration} className="px-4 py-2 rounded border border-gold text-goldSoft text-sm disabled:opacity-50">Save source section</button>
      </div>
    </div>
  </div>;
}
