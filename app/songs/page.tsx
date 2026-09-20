"use client";

import { useEffect, useState } from "react";
import Uploader from "@/components/Uploader";
import RequireSupabaseConfig from "@/components/RequireSupabaseConfig";
import { Song } from "@/types";
import OverflowMenu, { MenuItem } from "@/components/OverflowMenu";

type SongWithUrl = Song & { url: string | null };

export default function SongsPage(){return <RequireSupabaseConfig><SongsPageContent/></RequireSupabaseConfig>;}
function SongsPageContent(){
  const [songs,setSongs]=useState<SongWithUrl[]>([]);
  const [loading,setLoading]=useState(true);
  const [deleting,setDeleting]=useState<string|null>(null);
  const [error,setError]=useState("");

  async function load(){setLoading(true);try{const res=await fetch("/api/songs",{cache:"no-store"});const data=await res.json();if(!res.ok)throw new Error(data.error||"Could not load songs.");setSongs(data.songs??[]);}catch(e:any){setError(e.message??"Could not load songs.");}finally{setLoading(false);}}
  useEffect(()=>{void load();},[]);
  async function removeSong(song:SongWithUrl){if(!window.confirm(`Delete “${song.filename}”? This removes it from the library and Supabase Storage.`))return;setDeleting(song.id);setError("");try{const res=await fetch(`/api/songs/${encodeURIComponent(song.id)}`,{method:"DELETE"});const data=await res.json();if(!res.ok||data.error)throw new Error(data.error||"Could not delete song.");setSongs(prev=>prev.filter(x=>x.id!==song.id));if(data.warning)setError(data.warning);}catch(e:any){setError(e.message??"Could not delete song.");}finally{setDeleting(null);}}

  return <div className="space-y-8">
    <div><h1 className="font-display text-3xl text-ink mb-1">Songs</h1><p className="text-muted text-sm">{songs.length} songs uploaded</p></div>
    {error&&<div className="card border-red-900/60 p-3 text-sm text-red-300">{error}</div>}
    <Uploader kind="song" category="" categories={[]} onCategoryChange={()=>{}} onUploaded={load}/>
    {loading?<p className="text-muted text-sm">Loading…</p>:songs.length===0?<p className="text-muted text-sm">No songs yet. Upload a few tracks above.</p>:
      <div className="space-y-2">{songs.map(song=><div key={song.id} className="card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="min-w-0"><p className="text-sm text-ink truncate">{song.filename}</p><p className="text-xs text-muted">{song.duration?`${song.duration.toFixed(1)}s`:"duration unknown"}</p></div>
        <div className="flex items-center gap-3 shrink-0 flex-wrap">{song.url&&<audio controls src={song.url} className="h-8 max-w-[220px]"/>}<OverflowMenu label={`Options for ${song.filename}`}><MenuItem onClick={()=>void removeSong(song)} danger disabled={deleting===song.id}>{deleting===song.id?"Deleting…":"Delete song"}</MenuItem></OverflowMenu></div>
      </div>)}</div>}
  </div>;
}
