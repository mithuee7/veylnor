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

Both the web UI (`/api/generate`) and the n8n API (`/api/v1/reels`) call ONE pipeline, `lib/sequence-pipeline.ts`:

1. **User rules (`lib/instruction-constraints.ts`)** - explicit prohibitions in the reel instructions ("no private jets", "avoid grind"), energy requests and variety rules ("no car video after car video") are parsed and handed to Groq as a clearly separated `USER RULES` block. By default nothing is removed from Groq's list: Groq decides, and any rule it breaks is reported in the warning banner. Set `VEYNLOR_ENFORCE_CONSTRAINTS=1` for strict mode, which removes forbidden clips before Groq and repairs order rules afterwards.
2. **Groq (`lib/generate.ts`)** - decides WHICH video goes in WHICH slot. It sees `{id, folder, file, sec}` per clip, the slot durations, the user rules, the user's instructions verbatim, the song profile and optional reference blueprints. It does not produce timestamps.
3. **FFmpeg shot selection (`lib/stable-source.ts`)** - detects real cuts, keeps continuous shots at least as long as the slot, searches middle of video -> toward the end -> wraps to the beginning, and extracts exactly the slot length from inside one shot. Shots are never combined. If a chosen video has no long-enough shot, the next best allowed clip that has one is used; if none exists, the longest single shot is used and its last frame is held.

Set `VEYNLOR_DEBUG_PROMPTS=1` to log the exact final prompt and Groq's raw picks in the server logs.

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
UI render requests still use the existing background render-job system so the Generate page can show live FFmpeg progress.

## n8n / External API

Veylnor exposes an authenticated automation endpoint without changing the existing UI routes.

### Authentication

Set these Render environment variables:

```text
VEYNLOR_API_KEY=your-long-random-secret
VEYNLOR_ADMIN_PASSWORD=your-private-admin-password
VEYNLOR_ADMIN_SESSION_SECRET=another-long-random-secret
```

The first secret is for n8n. The last two are for the private `/admin` dashboard. Never put any of them in browser/client code.

n8n sends:

```text
Authorization: Bearer your-long-random-secret
```

### Generate + render one reel

`POST /api/v1/reels`

The endpoint uses the same Supabase clip library, category rules, Groq sequencing, beat-locked timing and FFmpeg render pipeline as the Veylnor UI.

Minimum automation payload:

```json
{
  "songId": "SONG_UUID",
  "songStart": 0,
  "songEnd": 15
}
```

Useful options:

```json
{
  "songId": "SONG_UUID",
  "songStart": 0,
  "songEnd": 15,
  "clipsPerBeat": 1,
  "reelInstructions": "Fast, aspirational luxury reel. Avoid peaceful/static footage.",
  "references": [],
  "textOverlay": {
    "enabled": true,
    "text": "our future",
    "size": 64,
    "font": "EB Garamond"
  },
  "render": true
}
```

`clipsPerBeat` is `1` by default. Use `2` for two visual clips per beat.

If `reelInstructions` is omitted, the saved `reel_preferences` value is used. If `references` is omitted, no reference blueprint is used.

### Synchronous API response

With `"render": true`, the API request stays open while Veylnor finishes sequence generation, FFmpeg rendering and Supabase upload. The POST does **not** return a `202`/job response first.

When the reel is ready, n8n receives:

```json
{
  "status": "complete",
  "jobId": "JOB_UUID",
  "reelUrl": "SIGNED_SUPABASE_RENDER_URL",
  "render": {
    "status": "complete",
    "statusPath": "/api/v1/reels/JOB_UUID"
  }
}
```

Because your current renders are normally under a minute, this is the intended n8n workflow: one HTTP Request node waits, then the next node receives the finished reel URL. There is no polling requirement for the normal flow.

The signed URL is temporary. n8n should download/store the MP4 or pass it to the next automation step soon after receiving it.

The existing `GET /api/v1/reels/{jobId}` endpoint remains available for diagnostics while a render is active or shortly after completion.

### Beat input

The API now detects BPM server-side when neither `beatInfo` nor `bpm` is supplied. It decodes only the requested song section with the server's FFmpeg installation, runs the same lightweight beat-detection approach used by Veylnor, derives the music profile, and then builds the deterministic beat grid.

For maximum control, n8n can still send an explicit `bpm` or complete `beatInfo`; `beatInfo` takes precedence over `bpm`, and either takes precedence over automatic detection.

### Reference reels

The API accepts either already analyzed `ReferenceAnalysis` objects or Supabase `references` storage paths such as:

```json
{
  "references": [
    { "path": "reference_reels/123-reference.mp4" }
  ]
}
```

When a path is supplied, Veylnor uses a short-lived private Supabase signed URL and runs the existing local FFmpeg/pixel/audio reference analysis. No reference frames are sent to Groq.

### Private API activity dashboard

Open:

```text
https://YOUR-VEYLNOR-DOMAIN/admin
```

The page is public only in the sense that someone can navigate to the URL. It reveals no API activity until the correct `VEYNLOR_ADMIN_PASSWORD` is supplied.

After login, the browser receives an `HttpOnly`, `Secure` production cookie signed with `VEYNLOR_ADMIN_SESSION_SECRET`. The cookie is the private admin session; the API key is never exposed to the browser.

The dashboard polls the server once per second and shows only API-created jobs, including:

- Request received
- Song loaded
- Reference analysis
- AI clip sequence
- Clip preparation
- Beat/source timing
- FFmpeg rendering
- MP4 ready

A normal visitor to Veylnor does not see these jobs. The admin jobs endpoint rejects requests without the private session.

### n8n flow

The normal workflow is simply:

1. Trigger (Schedule, Webhook, Airtable, Google Sheets, etc.)
2. Select the Veylnor `songId`.
3. Set `songStart` and `songEnd`; Veylnor detects BPM automatically unless you explicitly provide it.
4. HTTP Request → `POST /api/v1/reels` with the API key.
5. Wait for the HTTP Request node to finish.
6. Read `reelUrl` from the response.
7. Download/store/send the MP4 to the next service.

Example:

```bash
curl -X POST "https://YOUR-VEYLNOR-DOMAIN/api/v1/reels" \
  -H "Authorization: Bearer YOUR_VEYLNOR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "songId": "SONG_UUID",
    "songStart": 0,
    "songEnd": 15,
    "clipsPerBeat": 1,
    "render": true
  }'
```

### Existing routes remain unchanged

The automation API is additive. Existing UI endpoints such as `/api/generate`, `/api/render`, `/api/songs`, `/api/clips`, reference analysis and reel preferences are not removed or replaced.

The API activity and render-job stores are in-memory on the current single Render service instance. This matches the current Veylnor architecture and is sufficient for the intended single automated render at a time. A future horizontally scaled deployment should move job/activity state to a shared store.

## Testing

The uploaded repository did not contain a complete `node_modules` installation, and this environment could not finish fetching npm dependencies, so a final production `npm run build` was not claimed as verified here. Run `npm install && npm run build` before deployment and test one real API request against your Render/Supabase/Groq configuration.
