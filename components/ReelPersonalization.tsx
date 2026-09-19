"use client";

import { useEffect, useState } from "react";

const MAX_LENGTH = 4000;

export default function ReelPersonalization({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(!value.trim());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(value);
    if (!value.trim()) setEditing(true);
  }, [value]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/reel-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instructions: draft.slice(0, MAX_LENGTH) }),
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok || json.error) throw new Error(json.error || "Could not save reel preferences.");
      onChange(String(json.instructions ?? draft));
      setDraft(String(json.instructions ?? draft));
      setEditing(false);
    } catch (e: any) {
      setError(e?.message ?? "Could not save reel preferences.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="card p-5 space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p className="label">PERSONAL REEL INSTRUCTIONS · SAVED</p>
        <p className="text-sm text-muted mt-1">Tell Veylnor what should consistently feel like you: visual taste, audience, recurring ideas, things to avoid, pacing preferences, or anything else.</p>
      </div>
      {!editing && <button onClick={() => setEditing(true)} className="px-3 py-1.5 rounded border border-panelBorder text-xs text-ink hover:border-gold">Edit</button>}
    </div>

    {editing ? <div className="space-y-3">
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value.slice(0, MAX_LENGTH))}
        maxLength={MAX_LENGTH}
        rows={6}
        placeholder="Example: Keep the reel aspirational and fast. Favor women + cars for high-energy songs. Avoid generic stock-feeling views. Make the first 2 seconds immediately attention-grabbing. End on the strongest status/luxury visual."
        className="reel-notes w-full resize-y rounded-lg px-4 py-3 text-sm text-ink outline-none transition placeholder:text-muted/60"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] text-muted font-mono">{draft.length}/{MAX_LENGTH}</span>
        <button onClick={save} disabled={saving} className="px-4 py-2 rounded bg-gold text-base text-sm font-medium hover:opacity-90 disabled:opacity-50">{saving ? "Saving…" : "Done"}</button>
      </div>
    </div> : <div className="reel-notes-display rounded-lg px-4 py-3 text-sm text-ink whitespace-pre-wrap">{value || "No saved instructions yet."}</div>}

    {error && <p className="text-xs text-red-400">{error}</p>}
  </section>;
}
