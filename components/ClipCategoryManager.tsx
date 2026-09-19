"use client";

import { useEffect, useState } from "react";
import CategorySelect from "./CategorySelect";
import OverflowMenu, { MenuItem } from "./OverflowMenu";

export interface ClipCategory { id: string; name: string; created_at: string; }
interface Props { value: string; onChange: (categoryName: string) => void; onCategoriesChange?: (categories: ClipCategory[]) => void; }

export default function ClipCategoryManager({ value, onChange, onCategoriesChange }: Props) {
  const [categories,setCategories]=useState<ClipCategory[]>([]);
  const [loading,setLoading]=useState(true);
  const [newName,setNewName]=useState("");
  const [renameName,setRenameName]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  async function refresh() {
    setLoading(true); setError("");
    try {
      const res=await fetch("/api/categories",{cache:"no-store"}); const data=await res.json();
      if(!res.ok) throw new Error(data.error||"Could not load clip folders.");
      const next=data.categories??[]; setCategories(next); onCategoriesChange?.(next);
    } catch(e:any){setError(e?.message??"Could not load clip folders.");} finally{setLoading(false);}
  }
  useEffect(()=>{void refresh();},[]);
  const selected=categories.find(x=>x.name===value)??null;

  async function createCategory(){
    const name=newName.trim(); if(!name)return; setBusy(true); setError("");
    try{const res=await fetch("/api/categories",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})}); const data=await res.json(); if(!res.ok)throw new Error(data.error||"Could not create folder."); const next=[...categories,data.category].sort((a,b)=>a.name.localeCompare(b.name)); setCategories(next); onCategoriesChange?.(next); setNewName(""); onChange(data.category.name);}catch(e:any){setError(e?.message??"Could not create folder.");}finally{setBusy(false);}
  }
  async function renameCategory(){
    if(!selected)return; const name=renameName.trim(); if(!name)return; setBusy(true); setError("");
    try{const res=await fetch(`/api/categories/${encodeURIComponent(selected.id)}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({name})}); const data=await res.json(); if(!res.ok)throw new Error(data.error||"Could not rename folder."); const next=categories.map(x=>x.id===selected.id?data.category:x).sort((a,b)=>a.name.localeCompare(b.name)); setCategories(next); onCategoriesChange?.(next); onChange(data.category.name); setRenameName("");}catch(e:any){setError(e?.message??"Could not rename folder.");}finally{setBusy(false);}
  }
  async function deleteCategory(){
    if(!selected)return; if(!window.confirm(`Delete “${selected.name}”? This will PERMANENTLY DELETE every video in this folder and its Supabase Storage files. This cannot be undone.`))return;
    setBusy(true); setError("");
    try{const res=await fetch(`/api/categories/${encodeURIComponent(selected.id)}`,{method:"DELETE"}); const data=await res.json(); if(!res.ok)throw new Error(data.error||"Could not delete folder."); const next=categories.filter(x=>x.id!==selected.id); setCategories(next); onCategoriesChange?.(next); onChange(next[0]?.name??""); setRenameName("");}catch(e:any){setError(e?.message??"Could not delete folder.");}finally{setBusy(false);}
  }

  return <div className="card p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <span className="label">Clip folders</span>
      <CategorySelect value={value} categories={categories} onChange={onChange} disabled={loading||busy} />
      {selected&&<><input value={renameName} onChange={e=>setRenameName(e.target.value)} placeholder={`Rename “${selected.name}”`} maxLength={60} disabled={busy} className="bg-base border border-panelBorder rounded px-3 py-2 text-sm w-[210px]"/><button type="button" onClick={()=>void renameCategory()} disabled={!renameName.trim()||busy} className="px-3 py-2 rounded border border-gold text-goldSoft text-xs hover:bg-gold/10 disabled:opacity-40">Rename</button><OverflowMenu label="Folder options"><MenuItem onClick={()=>void deleteCategory()} danger disabled={busy}>{busy ? "Deleting…" : "Delete folder"}</MenuItem></OverflowMenu></>}
    </div>
    <div className="flex flex-wrap items-center gap-2"><input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();void createCategory();}}} placeholder="Create new clip folder" maxLength={60} disabled={busy} className="bg-base border border-panelBorder rounded px-3 py-2 text-sm w-[210px]"/><button type="button" onClick={()=>void createCategory()} disabled={!newName.trim()||busy} className="px-3 py-2 rounded border border-gold text-goldSoft text-xs hover:bg-gold/10 disabled:opacity-40">Create folder</button></div>
    <p className="text-[11px] text-muted">These folders are the AI clip categories. Renaming updates the category on every clip. Deleting a folder permanently deletes all videos inside it.</p>
    {error&&<p className="text-xs text-red-300">{error}</p>}
  </div>;
}
