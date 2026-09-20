"use client";

import { useState } from "react";
import { SequenceItem } from "@/types";
import ClipTrimModal from "./ClipTrimModal";
import ClipReplaceModal from "./ClipReplaceModal";

export default function SequenceEditor({
  items, onChange, onRegenerate, regenerating
}: {
  items: SequenceItem[];
  onChange: (items: SequenceItem[]) => void;
  onRegenerate: ()=>void;
  regenerating: boolean;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [editing, setEditing] = useState<SequenceItem | null>(null);
  const [replacing, setReplacing] = useState<SequenceItem | null>(null);

  function move(from:number,to:number) {
    if(from===to) return;
    const next=[...items]; const [x]=next.splice(from,1); next.splice(to,0,x);
    onChange(next.map((it,i)=>({...it,position:i+1})));
  }
  function toggleLock(i:number) {
    onChange(items.map((it,idx)=>idx===i?{...it,locked:!it.locked}:it));
  }
  function updateTrim(start:number,end:number) {
    if(!editing) return;
    const targetDuration = editing.targetDuration;
    const safeEnd = Number((start + targetDuration).toFixed(3));
    onChange(items.map(it=>it.position===editing.position?{...it,sourceStart:Number(start.toFixed(3)),sourceEnd:safeEnd,targetDuration}:it));
    setEditing(null);
  }
  async function replaceClip(nextClip: SequenceItem["clip"]) {
    if (!replacing) return;
    const slot = replacing;
    const targetDuration = Number(slot.targetDuration);
    const sourceDuration = Number(nextClip.duration ?? 0);
    if (sourceDuration > 0 && sourceDuration + 0.01 < targetDuration) return;
    setReplacing(null);
    // Ask FFmpeg for an uninterrupted section (middle -> end -> beginning). Falls back to the start if analysis is unavailable.
    let sourceStart = 0;
    let sourceEnd = Number(targetDuration.toFixed(3));
    let shot: SequenceItem["shot"];
    let shortShot = false;
    try {
      const r = await fetch("/api/shots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clipId: nextClip.id, target: targetDuration }) });
      const j = await r.json();
      if (r.ok && Number.isFinite(j.start) && Number.isFinite(j.end)) {
        sourceStart = j.start; sourceEnd = j.end;
        shot = { status: j.status, shotStart: j.shotStart, shotEnd: j.shotEnd, note: j.note };
        shortShot = j.end - j.start + 0.03 < targetDuration;
      }
    } catch { /* handled below */ }
    if (!shot) shot = { status: "unverified", shotStart: 0, shotEnd: sourceEnd, note: "Shot analysis failed; this section was not checked for cuts." };
    onChange(items.map((it) => it.position === slot.position ? {
      ...it, category: nextClip.category, clip: nextClip, sourceStart, sourceEnd, targetDuration, shot, shortShot,
    } : it));
  }

  return <div className="space-y-4">
    <div className="flex justify-between items-center">
      <div><p className="label">SEQUENCE</p><p className="text-xs text-muted">{items.reduce((a,b)=>a+b.targetDuration,0).toFixed(3)}s visual duration · drag to reorder</p></div>
      <button onClick={onRegenerate} disabled={regenerating} className="px-4 py-2 rounded border border-panelBorder text-sm hover:border-gold disabled:opacity-50">{regenerating?"Regenerating…":"Regenerate unlocked"}</button>
    </div>
    <div className="space-y-2">
      {items.map((item,i)=><div key={`${item.position}-${item.clip.id}`} draggable={!item.locked} onDragStart={()=>setDrag(i)} onDragOver={e=>e.preventDefault()} onDrop={()=>{if(drag!==null)move(drag,i);setDrag(null)}} onDragEnd={()=>setDrag(null)} className={`card p-3 flex gap-3 items-center cursor-grab active:cursor-grabbing ${drag===i?"opacity-50":""}`}>
        <div className="w-7 text-center font-display text-goldSoft">{i+1}</div>
        <div className="w-12 h-16 bg-black rounded overflow-hidden shrink-0">{item.clip.url&&<video src={item.clip.url} muted preload="metadata" playsInline className="w-full h-full object-cover"/>}</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-ink truncate">{item.clip.filename}</p>
          <p className="text-xs text-muted capitalize">{item.category}{item.role?` · ${item.role}`:""}</p>
          <p className="text-xs text-muted font-mono">Source {item.sourceStart.toFixed(3)}–{item.sourceEnd.toFixed(3)} · slot {item.targetDuration.toFixed(3)}s</p>
          {item.shortShot&&<p className="text-xs text-goldSoft">Only a shorter cut-free shot exists in this clip; its last frame is held to fill the slot.</p>}
          {!item.shortShot&&item.shot?.status==="unverified"&&<p className="text-xs text-muted">Scene detection unavailable; cuts not verified.</p>}
        </div>
        <button onClick={()=>toggleLock(i)} className={`text-xs px-2 py-1 rounded border ${item.locked?"border-gold text-goldSoft":"border-panelBorder text-muted"}`}>{item.locked?"Locked":"Lock"}</button>
        <button onClick={()=>setEditing(item)} className="text-xs px-3 py-2 rounded border border-panelBorder text-ink hover:border-gold">Edit</button>
        <button onClick={()=>setReplacing(item)} className="text-xs px-3 py-2 rounded border border-panelBorder text-ink hover:border-gold">Replace</button>
      </div>)}
    </div>
    {editing&&<ClipTrimModal item={editing} onConfirm={updateTrim} onClose={()=>setEditing(null)}/>} 
    {replacing&&<ClipReplaceModal item={replacing} excludedClipIds={items.map((item) => item.clip.id)} onConfirm={replaceClip} onClose={()=>setReplacing(null)}/>} 
  </div>;
}
