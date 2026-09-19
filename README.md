# Veylnor Reel Sequencer V2

V2 upgrades the existing V1 app without replacing its architecture:

**Clip library → song → exact song section → BPM beat grid → optional multi-reference analysis → saved reel preferences → AI sequence → exact clip sections → reorder/lock → inline MP4 preview → real FFmpeg MP4**

## What stayed from V1

- Existing dark Veylnor UI and routes
- Supabase browser configuration/localStorage flow
- Supabase Storage direct browser uploads
- Clips and Songs libraries
- Existing Postgres schema and metadata
- Groq `openai/gpt-oss-120b` sequencing
- Server-side secrets
- Render deployment model

## V2 additions

### Song section selection

The Generate page now loads the existing song library and provides a waveform/timeline with millisecond timestamps. Choose an exact start/end section; only that window is passed to beat analysis and rendering.

### Deterministic beat analysis

The selected audio window is decoded with Web Audio and analyzed by `web-audio-beat-detector`. The LLM does not calculate BPM or beat timing. The resulting BPM, beat timestamps and segment durations are supplied to Groq.

### Reference reel blueprint

Upload one or several reference reels. They are stored in the private Supabase `references` bucket. Reference analysis is local-only: FFmpeg plus server-side pixel/audio calculations extract cut timing, motion, composition, color, frame change, beat alignment, repetition patterns and hook/payoff structure. No reference frames are sent to Groq or any vision API.

### Smarter sequencing

Groq receives the live clip manifest, BPM-locked timing, optional multi-reference blueprints and the saved personal reel instructions. High-energy music enforces the compatible clip pool and preferred folders in the backend before the model chooses exact clips.

### Exact clip source selection

Every generated clip has a source start/end selection. The Edit control opens a source-video preview with timestamp controls. The selected source interval is the interval passed to FFmpeg.

### Reorder + lock

Sequence cards are draggable. Individual positions can be locked. Regeneration sends locked positions back to Groq so the other positions can be regenerated around them.

### Preview + final MP4

Both preview and final export use the same real server-side FFmpeg pipeline. The final export is:

- 1080×1920
- 9:16
- H.264 video
- AAC audio
- MP4 container
- `+faststart`

The result is uploaded to the private Supabase `renders` bucket and returned as a signed URL.

## Supabase V2 setup

Run the updated `supabase/schema.sql` in the Supabase SQL editor. It preserves the V1 tables/buckets and adds:

- `references` private bucket
- `reel_preferences` singleton table for saved per-reel instructions
- `renders` private bucket

Run `supabase/reel_preferences.sql` once in Supabase to enable the saved personalized reel-instructions box.

## Render / FFmpeg

The Render build command installs FFmpeg in the build environment before building Next.js:

```text
apt-get update && apt-get install -y ffmpeg && npm install && npm run build
```

The application invokes `FFMPEG_PATH` when supplied, otherwise the `ffmpeg` executable on PATH. This means production does not depend on FFmpeg being installed on the developer's computer.

The final MP4 is not permanently stored on Render. Render writes only a temporary file under `/tmp`, uploads the result to Supabase Storage, returns a signed URL, then removes the temporary file.

## Security

- `GROQ_API_KEY` remains server-side.
- `SUPABASE_SERVICE_ROLE_KEY` remains server-side.
- Browser Supabase config contains only the project URL + anon/public key.
- Source media is never uploaded through the Next.js API.
- The server creates short-lived signed URLs for FFmpeg to read private source media.
- Reference and render buckets remain private.

## API shape

`POST /api/generate` accepts the analyzed BPM beat grid, optional multiple reference analyses, saved reel instructions, and locked positions. `GET/PATCH /api/reel-preferences` stores the persistent personalization text.

`POST /api/render` accepts:

```json
{
  "songId": "uuid",
  "songStart": 102.0,
  "songEnd": 117.0,
  "sequence": [
    { "clipId": "uuid", "start": 4.2, "end": 5.1 }
  ]
}
```

The render endpoint validates source IDs against Supabase, creates signed source URLs, runs FFmpeg, uploads the MP4, and returns a signed output URL.

This makes a future n8n `POST /api/generate` / render workflow straightforward without adding n8n integration now.

## Testing

The implementation was inspected and the FFmpeg render pipeline was exercised locally with synthetic MP4/audio inputs, including real H.264/AAC MP4 output and 9:16 scaling.

A full `npm run build` could not be completed in this environment because the uploaded repository did not contain `node_modules`, and this environment could not fetch the required npm dependencies from the registry. The command failed at `next: not found`. Therefore a production Next.js build and real Supabase/Groq/Render credential test have **not** been claimed as verified.

After installing dependencies in an environment with npm registry access:

```bash
npm install
npm run build
npm run start
```

Then run the V2 flow against the real Supabase/Groq configuration and deploy through the included `render.yaml`.

## V2 render jobs
Render requests return a job ID immediately. The persistent Render service runs FFmpeg in the background, while the browser polls `/api/render?jobId=...` until the MP4 is uploaded to the private Supabase `renders` bucket. This avoids long browser/Render HTTP request timeouts.
