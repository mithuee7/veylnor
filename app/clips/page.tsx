"use client";

import { useEffect, useState } from "react";
import Uploader from "@/components/Uploader";
import RequireSupabaseConfig from "@/components/RequireSupabaseConfig";
import ClipCategoryManager, { ClipCategory } from "@/components/ClipCategoryManager";
import { Clip } from "@/types";
import OverflowMenu, { MenuItem } from "@/components/OverflowMenu";
import ClipPlayerModal from "@/components/ClipPlayerModal";

type ClipWithUrl = Clip & { url: string | null };

export default function ClipsPage() { return <RequireSupabaseConfig><ClipsPageContent /></RequireSupabaseConfig>; }

function ClipsPageContent() {
  const [clips,setClips]=useState<ClipWithUrl[]>([]);
  const [categories,setCategories]=useState<ClipCategory[]>([]);
  const [category,setCategory]=useState("");
  const [loading,setLoading]=useState(true);
  const [loadingMore,setLoadingMore]=useState(false);
  const [hasMore,setHasMore]=useState(false);
  const [deleting,setDeleting]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [playing,setPlaying]=useState<ClipWithUrl|null>(null);
  const [renaming,setRenaming]=useState<ClipWithUrl|null>(null);
  const [renameValue,setRenameValue]=useState("");
  const [renamingBusy,setRenamingBusy]=useState(false);
  const PAGE_SIZE=120;

  async function load(reset=true) {
    if(reset) setLoading(true); else setLoadingMore(true);
    try {
      const offset=reset?0:clips.length;
      const res=await fetch(`/api/clips?limit=${PAGE_SIZE}&offset=${offset}`,{cache:"no-store"});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||"Could not load clips.");
      setClips(prev=>reset?(data.clips??[]):[...prev,...(data.clips??[])]);
      setHasMore(Boolean(data.hasMore));
    } catch(e:any){setError(e.message??"Could not load clips.");}
    finally{setLoading(false);setLoadingMore(false);}
  }
  useEffect(()=>{void load(true);},[]);


  function beginRename(clip: ClipWithUrl) {
    setRenaming(clip);
    setRenameValue(clip.filename);
    setError("");
  }

  async function saveRename() {
    if (!renaming) return;
    const filename = renameValue.trim();
    if (!filename || filename === renaming.filename) { setRenaming(null); return; }
    setRenamingBusy(true); setError("");
    try {
      const res = await fetch(`/api/clips/${encodeURIComponent(renaming.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || "Could not rename clip.");
      setClips(prev => prev.map(c => c.id === renaming.id ? { ...c, filename: data.clip?.filename ?? filename } : c));
      setPlaying(prev => prev?.id === renaming.id ? { ...prev, filename: data.clip?.filename ?? filename } : prev);
      setRenaming(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not rename clip.");
    } finally {
      setRenamingBusy(false);
    }
  }

  async function removeClip(clip:ClipWithUrl) {
    if(!window.confirm(`Delete “${clip.filename}”? This removes it from the library and Supabase Storage.`)) return;
    setDeleting(clip.id); setError("");
    try{const res=await fetch(`/api/clips/${encodeURIComponent(clip.id)}`,{method:"DELETE"}); const data=await res.json(); if(!res.ok||data.error)throw new Error(data.error||"Could not delete clip."); setClips(prev=>prev.filter(x=>x.id!==clip.id)); if(data.warning)setError(data.warning);}catch(e:any){setError(e.message??"Could not delete clip.");}finally{setDeleting(null);}
  }

  const visible=category?clips.filter(c=>c.category===category):clips;
  const grouped=categories.map(cat=>({category:cat.name,items:visible.filter(c=>c.category===cat.name)})).filter(g=>g.items.length>0);

  return <div className="space-y-8">
    <div><h1 className="font-display text-3xl text-ink mb-1">Clips</h1><p className="text-muted text-sm">{clips.length} clips loaded</p></div>
    {error&&<div className="card border-red-900/60 p-3 text-sm text-red-300">{error}</div>}
    <ClipCategoryManager value={category} onChange={setCategory} onCategoriesChange={setCategories}/>
    <Uploader kind="clip" category={category} categories={categories} onCategoryChange={setCategory} onUploaded={()=>load(true)}/>
    {loading?<p className="text-muted text-sm">Loading…</p>:grouped.length===0?<p className="text-muted text-sm">No clips in this folder yet.</p>:
      <div className="space-y-10">{grouped.map(g=><div key={g.category}>
        <h2 className="font-display text-lg text-goldSoft mb-3">{g.category}<span className="text-muted text-sm font-body ml-2">({g.items.length})</span></h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">{g.items.map(clip=><div key={clip.id} className="card overflow-hidden">
          <button type="button" className="aspect-[9/16] bg-black w-full block cursor-pointer" onClick={() => setPlaying(clip)} aria-label={`Play ${clip.filename}`}>{clip.url&&<video src={clip.url} muted preload="metadata" playsInline className="w-full h-full object-cover"/>}<span className="sr-only">Play clip</span></button>
          <div className="p-2 space-y-2">
            <div className="flex items-start gap-2"><div className="min-w-0 flex-1"><button type="button" onClick={() => setPlaying(clip)} className="text-xs text-ink truncate block max-w-full hover:text-goldSoft text-left">{clip.filename}</button><p className="text-xs text-muted">{clip.duration?`${clip.duration.toFixed(1)}s`:"—"}</p></div><OverflowMenu label={`Options for ${clip.filename}`}><MenuItem onClick={()=>setPlaying(clip)}>Play clip</MenuItem><MenuItem onClick={()=>beginRename(clip)}>Rename clip</MenuItem><MenuItem onClick={()=>void removeClip(clip)} danger disabled={deleting===clip.id}>{deleting===clip.id?"Deleting…":"Delete clip"}</MenuItem></OverflowMenu></div>
          </div>
        </div>)}</div>
      </div>)}</div>}
    {!loading&&hasMore&&<button onClick={()=>load(false)} disabled={loadingMore} className="px-4 py-2 rounded border border-panelBorder text-sm text-ink hover:border-gold disabled:opacity-50">{loadingMore?"Loading…":"Load more clips"}</button>}

    {renaming && <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm p-4 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) setRenaming(null); }}>
      <div className="card w-full max-w-md p-5 space-y-4">
        <div><p className="font-display text-lg text-ink">Rename clip</p><p className="text-xs text-muted mt-1">The new name is also used as AI clip metadata. The stored video file itself is not moved.</p></div>
        <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void saveRename(); if (e.key === "Escape") setRenaming(null); }} maxLength={240} className="w-full bg-base border border-panelBorder rounded px-3 py-2 text-sm text-ink outline-none focus:border-gold" />
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setRenaming(null)} className="px-3 py-2 rounded border border-panelBorder text-sm text-muted">Cancel</button><button type="button" onClick={() => void saveRename()} disabled={!renameValue.trim() || renamingBusy} className="px-4 py-2 rounded border border-gold text-goldSoft text-sm disabled:opacity-40">{renamingBusy ? "Saving…" : "Save name"}</button></div>
      </div>
    </div>}

    {playing && <ClipPlayerModal clip={playing} onClose={() => setPlaying(null)} />}
  </div>;
}
