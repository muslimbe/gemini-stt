# Project philosophy

When changing this codebase, optimize in this order:

1. **UX.** What the user sees and feels using the bot. Per-chat command scoping, helpful command menus, clear error messages — these stay even if they cost LOC.
2. **Readable.** Code a person can understand at a glance.
3. **Simple.** Each piece does one thing the most direct way.
4. **Solid.** Don't drop error context, debugging info, or operational signals just to save lines.
5. **Few LOC.** Less code is better — but only after the four above are satisfied.

Fewer lines is the _last_ goal, not the first. If a refactor makes the file shorter but harder to read, or worsens the user experience, undo it.

## Concrete rules

- **UX over LOC.** Things like per-chat admin command scope, `/list`, helpful "ignored: wrong mime" replies — keep them. They cost a few lines and save real friction.
- **Don't loop to dedupe handler-style code.** Four explicit `bot.on(...)` lines beat a `for` loop with dynamic property access. Repetition is fine when each line is independently scannable.
- **Don't introduce premature abstractions.** 3–7 similar lines are acceptable. Abstract only when duplication is large _and_ the pattern recurs across modules.
- **Delete dead code aggressively.** Returned fields nobody reads, computed values nobody uses — gone.
- **Pass-through configs.** When a function destructures the fields it cares about, pass the whole config object instead of copying field-by-field.
- **Keep error context.** If a function enriches errors with diagnostic info (path, size, stderr tail), don't strip it for LOC.
- **Comments only when WHY is non-obvious.** Don't restate WHAT the code does.
- **No backwards-compat shims** when a clean change is possible.

## Naming conventions

- **Prefer well-known abbreviations** when they exist: `fmt` (not `format`), `msg` (not `message`), `tg` (not `telegram`), `cfg` (not `config`), `req`/`res` for HTTP, `idx`/`i` for index. Don't invent obscure abbreviations — only use ones a JS developer will recognize at a glance.
- **Stay consistent within a family.** If `fmtDuration`/`fmtBytes` exist, the third sibling is `fmtOutput`, not `formatOutput`. Picking the convention isn't the point — _not breaking it_ is.
- **Function declaration style:** multi-line bodies use `function foo() { … }`; single-line returns use `const foo = … => …`. Examples: `sleep`, `ts`, `isAdmin` are arrow; `optimize`, `withRetry`, `extractReason` are `function`.
- **File names:** lowercase, single-word, domain-noun. `audio.js`, `gemini.js`, `download.js` — never generic plurals like `files.js` or `utils.js`.
- **Constants:** UPPER_SNAKE_CASE with the same abbreviation rules (`MSG_THRESHOLD`, not `MESSAGE_THRESHOLD`).
- **Parameter names:** prefer explicit (`bytes`, `seconds`) over single letters, except in tiny callbacks (`r`, `i`, `pos`) where the surrounding context makes the meaning obvious.

## Operational notes

- Two entry points over one pipeline ([src/pipeline.js](src/pipeline.js)): an MCP server (streamable HTTP, stateless) with one tool, `transcribe`, used by the tars bot ([src/server.js](src/server.js)), and a standalone Telegram bot ([src/bot.js](src/bot.js)). Compose runs them as two services, `stt` and `bot`, from one image.
- Prompt at [src/prompt.md](src/prompt.md) is read once at startup. Restart the service after editing.
- The only persistent state is the bot's allowlist (`data/access.json`, in the `bot-data` volume); the rest are temp working files. Logs go to stdout (`docker compose logs`).
- The MCP server reads files only under `MEDIA_DIR` — tars's `data/attachments`, mounted read-only at the same path as in the tars container.
- The bot uses the cloud Bot API (20 MB download cap). Media handlers are fire-and-forget so a long job doesn't block Telegraf's update loop.
- Video is supported by extracting the audio track via ffmpeg (`-vn`).
