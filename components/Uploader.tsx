"use client";

import { useRef, useState } from "react";
import { useSupabaseConfig } from "@/contexts/SupabaseConfigContext";

interface UploaderProps {
  kind: "clip" | "song";
  onUploaded: () => void;
  categories: { id: string; name: string }[];
  category: string;
  onCategoryChange: (category: string) => void;
}

interface FileStatus {
  name: string;
  state: "pending" | "uploading" | "done" | "error";
  error?: string;
}

function getMediaDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(file.type.startsWith("audio") ? "audio" : "video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      resolve(Number.isFinite(el.duration) ? el.duration : null);
      URL.revokeObjectURL(el.src);
    };
    el.onerror = () => resolve(null);
    el.src = URL.createObjectURL(file);
  });
}

export default function Uploader({ kind, onUploaded, categories, category, onCategoryChange }: UploaderProps) {
  const { client: supabase } = useSupabaseConfig();
  const [files, setFiles] = useState<FileStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList) {
    if (!supabase) {
      setFiles([{ name: "", state: "error", error: "Supabase is not configured." }]);
      return;
    }

    const list = Array.from(fileList);
    setFiles(list.map((f) => ({ name: f.name, state: "pending" })));
    setBusy(true);

    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      setFiles((prev) =>
        prev.map((f, idx) => (idx === i ? { ...f, state: "uploading" } : f))
      );

      try {
        const duration = await getMediaDuration(file);

        const urlRes = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            filename: file.name,
            category: kind === "clip" ? category : undefined,
          }),
        });
        const { path, token, bucket, error: urlError } = await urlRes.json();
        if (urlError) throw new Error(urlError);

        const { error: uploadError } = await supabase.storage
          .from(bucket)
          .uploadToSignedUrl(path, token, file);
        if (uploadError) throw uploadError;

        const metaRes = await fetch(kind === "clip" ? "/api/clips" : "/api/songs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            category: kind === "clip" ? category : undefined,
            storage_path: path,
            duration,
          }),
        });
        const metaJson = await metaRes.json();
        if (metaJson.error) throw new Error(metaJson.error);

        setFiles((prev) => prev.map((f, idx) => (idx === i ? { ...f, state: "done" } : f)));
      } catch (e: any) {
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, state: "error", error: e.message ?? "Upload failed" } : f
          )
        );
      }
    }

    setBusy(false);
    onUploaded();
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-center gap-4">
        {kind === "clip" && (
          <select
            value={category}
            onChange={(e) => onCategoryChange(e.target.value)}
            disabled={busy || categories.length === 0}
            className="bg-base border border-panelBorder rounded px-3 py-2 text-sm"
          >
            <option value="">Select clip folder</option>
            {categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        )}

        <label
          className={`px-4 py-2 text-sm rounded border border-gold text-goldSoft cursor-pointer hover:bg-gold/10 transition-colors ${
            busy ? "opacity-50 pointer-events-none" : ""
          }`}
        >
          {kind === "clip" ? "Upload clips" : "Upload songs"}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={kind === "clip" ? "video/*" : "audio/*"}
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </label>



        {kind === "clip" && (
          <span className="label">All files in this batch go into "{category || "no folder selected"}"</span>
        )}
      </div>

      {files.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between text-muted">
              <span className="truncate max-w-[70%]">{f.name}</span>
              <span
                className={
                  f.state === "done"
                    ? "text-gold"
                    : f.state === "error"
                    ? "text-red-400"
                    : "text-muted"
                }
              >
                {f.state === "pending" && "waiting"}
                {f.state === "uploading" && "uploading…"}
                {f.state === "done" && "done"}
                {f.state === "error" && (f.error ?? "error")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
