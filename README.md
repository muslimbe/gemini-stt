# gemini-stt

Voice, audio and video transcription with Gemini, in two forms from one codebase:

- **`stt`** — an MCP server for the [tars](https://github.com/muslimbe/tars) bot, with one tool, `transcribe`: give it the path of a file tars received, get back the transcript.
- **`bot`** — a standalone Telegram bot: send it a voice note, audio or video, get the transcript as a reply.

Both share the same pipeline:

- **Audio optimization** — silence trim + speedup + Opus re-encode. ~30–40% cheaper Gemini calls.
- **Speaker diarization**, Uzbek/Russian/English code-switching (configured in [`src/prompt.md`](src/prompt.md)).

## Setup

```bash
cp .env.example .env      # fill in GEMINI_API_KEY, BOT_TOKEN, ADMIN_USER_ID
docker compose up -d --build
docker compose logs -f
```

The bot needs its own token from [@BotFather](https://t.me/BotFather), not tars's: Telegram lets only one process poll a token. To run just one of the two, name it: `docker compose up -d stt`.

`stt` joins tars's docker network (`tars_default`), so tars must be up first. Enable it in tars's `plugins.json` and restart tars:

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

**MCP (`stt`)**

1. tars saves an inbound voice note, audio or video under `data/attachments/` and shows the model an `[attachment: <path> type=audio/…]` marker.
2. The model calls `transcribe` with that path. This service sees the same directory, mounted read-only at the same path.
3. ffmpeg extracts audio (video stream dropped) and optimizes: trim silences, speed up, encode to 16 kHz mono Opus.
4. The file is uploaded to the Gemini File API; `generateContent` runs with the system instruction from [`src/prompt.md`](src/prompt.md).
5. The transcript is the tool's result.

**Telegram (`bot`)**

1. You send a voice note, audio, video, video note, or an audio/video document.
2. The bot downloads it and shows one status message that it edits as the job moves: queued, downloading, optimizing, transcribing.
3. The transcript comes as a reply to your file: a message, or `transcript-<id>.txt` when it's too long for one.

Only the admin and allowlisted users get answers; others are ignored. `/whoami` shows anyone their ID. The admin manages the list with `/allow <id>`, `/deny <id>` and `/list`; it is kept in the `bot-data` docker volume.

Edit [`src/prompt.md`](src/prompt.md) to change transcription behavior (speaker labels, language, formatting), then `docker compose restart`.

## Configuration

Defaults work; tune in `.env` only if needed.

- `GEMINI_API_KEY` (required) — from <https://aistudio.google.com/apikey>.
- `BOT_TOKEN`, `ADMIN_USER_ID` (required by `bot`) — the bot's token and your Telegram user ID.
- `GEMINI_MODEL` — `gemini-3.5-flash` (default). Pro models (`gemini-3.1-pro-preview`) need billing on the API key. `gemini-2.5-pro` is closed to new users.
- `MAX_CONCURRENT` — simultaneous jobs per service, the rest queue (default 4).
- `TARS_ATTACHMENTS_DIR` — host path of tars's `data/attachments` (default `../tars/data/attachments`).

Audio optimization parameters (silence trim, 1.25× speedup) are hardcoded in [`src/audio.js`](src/audio.js).

## Limits

- Both tars and the bot download through Telegram's cloud Bot API, so inputs cap at 20 MB.
- tars ends a turn that shows no activity for 10 minutes (`TARS_LIVENESS_TIMEOUT_SECONDS`), which bounds how long one transcription may take.
