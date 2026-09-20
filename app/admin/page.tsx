"use client";

import { useEffect, useState } from "react";

interface Job {
  id: string;
  status: "processing" | "complete" | "failed";
  stage: string;
  progress: number;
  songId?: string;
  songFilename?: string;
  renderJobId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

async function json(res: Response) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function pct(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export default function AdminPage() {
  const [configured, setConfigured] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [loggingIn, setLoggingIn] = useState(false);

  async function loadSession() {
    const res = await fetch("/api/admin/session", { cache: "no-store" });
    const data = await json(res);
    setConfigured(data.configured !== false);
    setAuthenticated(Boolean(data.authenticated));
  }

  async function loadJobs() {
    const res = await fetch("/api/admin/jobs", { cache: "no-store" });
    const data = await json(res);
    if (res.status === 401) {
      setAuthenticated(false);
      return;
    }
    if (!res.ok) throw new Error(data.error || "Could not load API activity.");
    setJobs(data.jobs ?? []);
  }

  useEffect(() => { void loadSession(); }, []);

  useEffect(() => {
    if (!authenticated) return;
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 1000);
    return () => window.clearInterval(timer);
  }, [authenticated]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setLoggingIn(true);
    setError("");
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await json(res);
      if (!res.ok) throw new Error(data.error || "Login failed.");
      setPassword("");
      setAuthenticated(true);
    } catch (e: any) {
      setError(e?.message || "Login failed.");
    } finally {
      setLoggingIn(false);
    }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setAuthenticated(false);
    setJobs([]);
  }

  if (!configured) {
    return <main className="min-h-screen bg-page text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-panelBorder bg-panel p-6 space-y-3">
        <h1 className="text-xl font-medium">Veylnor Admin</h1>
        <p className="text-sm text-muted">Admin authentication is not configured on this server yet.</p>
      </div>
    </main>;
  }

  if (!authenticated) {
    return <main className="min-h-screen bg-page text-foreground flex items-center justify-center p-6">
      <form onSubmit={login} className="w-full max-w-md rounded-2xl border border-panelBorder bg-panel p-7 space-y-5">
        <div>
          <p className="text-[10px] tracking-[0.28em] uppercase text-goldSoft">Private</p>
          <h1 className="mt-2 text-2xl font-medium">Veylnor Admin</h1>
          <p className="mt-2 text-sm text-muted">Private API generation activity.</p>
        </div>
        <input
          autoFocus
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Admin password"
          className="w-full rounded-xl border border-panelBorder bg-page px-4 py-3 outline-none focus:border-gold"
        />
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button disabled={loggingIn} className="w-full rounded-xl bg-gold text-black py-3 font-medium disabled:opacity-50">
          {loggingIn ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>;
  }

  return <main className="min-h-screen bg-page text-foreground p-5 md:p-8">
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] tracking-[0.28em] uppercase text-goldSoft">Private</p>
          <h1 className="mt-2 text-2xl md:text-3xl font-medium">API Activity</h1>
          <p className="mt-1 text-sm text-muted">Only authenticated admin sessions can see these API jobs.</p>
        </div>
        <button onClick={logout} className="rounded-xl border border-panelBorder px-4 py-2 text-sm hover:border-gold">Log out</button>
      </header>

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-panelBorder bg-panel p-8 text-center text-muted text-sm">No API reel requests yet.</div>
      ) : (
        <div className="space-y-4">
          {jobs.map(job => {
            const progress = pct(job.progress);
            return <section key={job.id} className="rounded-2xl border border-panelBorder bg-panel p-5 space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${job.status === "processing" ? "bg-gold animate-pulse" : job.status === "complete" ? "bg-emerald-400" : "bg-red-400"}`} />
                    <span className="text-sm font-medium uppercase tracking-wider">{job.status}</span>
                  </div>
                  <p className="mt-2 text-lg">{job.songFilename || "API reel request"}</p>
                  <p className="mt-1 text-xs text-muted">Started {formatTime(job.createdAt)} · {job.id}</p>
                </div>
                <span className="text-xl font-mono text-goldSoft">{progress}%</span>
              </div>

              <div className="h-2 rounded-full bg-page overflow-hidden">
                <div className="h-full bg-gold transition-[width] duration-500" style={{ width: `${progress}%` }} />
              </div>

              <div className="grid gap-2 sm:grid-cols-2 text-sm">
                {[
                  ["Request received", progress >= 2],
                  ["Song loaded", progress >= 8],
                  ["Reference analysis", progress >= 15],
                  ["AI clip sequence", progress >= 30],
                  ["Clip preparation", progress >= 55],
                  ["Beat/source timing", progress >= 72],
                  ["FFmpeg rendering", progress >= 76],
                  ["MP4 ready", job.status === "complete"],
                ].map(([label, done]) => <div key={String(label)} className="flex items-center gap-2">
                  <span className={done ? "text-emerald-400" : "text-muted"}>{done ? "✓" : "○"}</span>
                  <span className={done ? "text-foreground" : "text-muted"}>{String(label)}</span>
                </div>)}
              </div>

              <div className="text-sm text-muted">{job.stage}</div>
              {job.error && <div className="rounded-xl border border-red-400/30 bg-red-400/5 p-3 text-sm text-red-300">{job.error}</div>}
            </section>;
          })}
        </div>
      )}
    </div>
  </main>;
}
