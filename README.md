# gemini-stt

A transcription service for the [tars](https://github.com/muslimbe/tars) bot. It is an MCP server with one tool, `transcribe`: give it the path of a voice note, audio file or video the bot received, get back a transcript from Gemini.

- **Audio optimization** — silence trim + speedup + Opus re-encode. ~30–40% cheaper Gemini calls.
- **Speaker diarization**, Uzbek/Russian/English code-switching (configured in [`src/prompt.md`](src/prompt.md)).
- **No Telegram of its own** — tars saves the file, the bot's model calls the tool.

## Setup

Runs next to tars on the same server, on tars's docker network (`tars_default`), so tars must be up first.

```bash
cp .env.example .env      # fill in GEMINI_API_KEY
docker compose up -d --build
docker compose logs -f stt
```

Then enable it in tars's `plugins.json` and restart tars:

```json
{
  "name": "stt",
  "type": "http",
  "url": "http://stt:8080/mcp",
  "allowed_tools": ["mcp__stt"],
  "enabled": true
}
```

## How it works

1. tars saves an inbound voice note, audio or video under `data/attachments/` and shows the model an `[attachment: <path> type=audio/…]` marker.
2. The model calls `transcribe` with that path. This service sees the same directory, mounted read-only at the same path.
3. ffmpeg extracts audio (video stream dropped) and optimizes: trim silences, speed up, encode to 16 kHz mono Opus.
4. The file is uploaded to the Gemini File API; `generateContent` runs with the system instruction from [`src/prompt.md`](src/prompt.md).
5. The transcript is the tool's result.

Edit [`src/prompt.md`](src/prompt.md) to change transcription behavior (speaker labels, language, formatting), then `docker compose restart stt`.

## Configuration

Defaults work; tune in `.env` only if needed.

- `GEMINI_API_KEY` (required) — from <https://aistudio.google.com/apikey>.
- `GEMINI_MODEL` — `gemini-3.5-flash` (default). Pro models (`gemini-3.1-pro-preview`) need billing on the API key. `gemini-2.5-pro` is closed to new users.
- `MAX_CONCURRENT` — simultaneous jobs, the rest queue (default 4).
- `TARS_ATTACHMENTS_DIR` — host path of tars's `data/attachments` (default `../tars/data/attachments`).

Audio optimization parameters (silence trim, 1.25× speedup) are hardcoded in [`src/audio.js`](src/audio.js).

## Limits

- tars downloads files through Telegram's cloud Bot API, so inputs cap at 20 MB.
- tars ends a turn that shows no activity for 10 minutes (`TARS_LIVENESS_TIMEOUT_SECONDS`), which bounds how long one transcription may take.
