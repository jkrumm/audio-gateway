# audio-proxy → audio-gateway: Behavioral Contract

Extracted from the original `audio-proxy` service (`../audio-proxy`). This is the contract the
greenfield rebuild ports against. Section numbers are referenced from `PRD.md`. Where the PRD's
Decisions diverge from this document (concurrency, the 3 bug fixes, the usage sink, renames), the
PRD wins.

A Bun service that fronts the IU "unified audio" upstream with an OpenAI-compatible API (STT + TTS),
adds a native Gemini expressive-TTS pipeline, and logs every call to local SQLite. Source is 7 TS
files (~700 LOC). No runtime npm dependencies — Bun built-ins (`Bun.serve`, `bun:sqlite`, `Bun.spawn`)
plus the system `ffmpeg`/`ffprobe` binaries.

## 1. File tree

Repo root:
- `package.json` — manifest; scripts, devDeps only (no runtime deps).
- `tsconfig.json` — strict ESNext/bundler TS config, `noEmit`.
- `bun.lock` — lockfile (only devDeps: @types/bun, typescript).
- `.env.tpl` — committed dev secrets template of `op://` references; resolved at runtime by `op run`.
- `.gitignore` — ignores `node_modules/`, `.env`, `data/`, `*.log`, `.DS_Store`, `bun.lockb`.
- `README.md` — behavioral doc (routes, STT/TTS behavior, config table, setup).
- `LICENSE` — MIT, "Copyright (c) 2026 Johannes Krumm".
- `data/usage.db` (+ `-shm`, `-wal`) — runtime SQLite usage log (gitignored).

`src/`:
- `index.ts` — `Bun.serve` entry; routing, auth gate, `/health`, `/models`, top-level error→500 wrap.
- `config.ts` — single source of all env parsing; exports a frozen `config` object.
- `iu.ts` — upstream URL builders (`iuUrl`, `iuGeminiUrl`) + bearer-header helper (`iuHeaders`).
- `usage.ts` — bun:sqlite DB init, schema, `recordUsage()`.
- `transcriptions.ts` — STT handler; format synth (verbose_json/srt/vtt), language steering.
- `speech.ts` — TTS dispatcher; Gemini-vs-passthrough split, passthrough proxy.
- `gemini-tts.ts` — Gemini expressive TTS pipeline (prep → synth → concat → transcode); config/fetch/ffmpeg deps.
- `gemini-tts-core.ts` — pure, config-free transforms (prep parsing, chunk-limit enforcement, PCM→WAV); unit-testable.
- `gemini-tts.test.ts` — bun:test unit tests for the core transforms.

`launchd/`:
- `com.jkrumm.audio-proxy.plist.template` — LaunchAgent plist template (`__HOME__` placeholder).
- `install-agent.sh` — renders the template into `~/Library/LaunchAgents` and `launchctl load`s it.
- `start-audio-proxy.sh` — launchd wrapper; reads Keychain creds, derives URLs, execs bun.

## 2. package.json essentials

- `name`: `"audio-proxy"` → rename to `"audio-gateway"`.
- `version`: `"0.1.0"`; `type`: `"module"`; `license`: `"MIT"`.
- `scripts`:
  - `dev`: `npx kill-port 7716 && op run --account tkrumm --env-file=.env.tpl -- bun --watch src/index.ts`
  - `start`: `op run --account tkrumm --env-file=.env.tpl -- bun src/index.ts`
  - `install-agent`: `bash launchd/install-agent.sh`
  - `typecheck`: `tsc --noEmit`
  - `test`: `bun test`
- `dependencies`: **none**. `devDependencies`: `@types/bun: latest`, `typescript: ^5`.
- No `engines`, no `trustedDependencies`. Lockfile implies Bun 1.3.x runtime target.

## 3. tsconfig compilerOptions

`lib:["ESNext"]`, `target:"ESNext"`, `module:"ESNext"`, `moduleResolution:"bundler"`, `types:["bun-types"]`,
`strict:true`, `noUncheckedIndexedAccess:true`, `noImplicitOverride:true`, `skipLibCheck:true`, `noEmit:true`,
`verbatimModuleSyntax:true`. `include:["src"]`. (`verbatimModuleSyntax` forces `import type` for type-only imports.)

## 4. Config / env surface

All env is read **only** in `config.ts`. `required()` throws `Missing required env var: <name>` at startup.
Trailing slashes are stripped from both base URLs via `.replace(/\/+$/, "")`.

| Env var | Required | Default | Parse | Controls |
|-|-|-|-|-|
| `PORT` | no | `7716` | `Number()` | Listen port. |
| `IU_API_KEY` | yes | — | string | Upstream bearer; reused for OpenAI, Gemini, and prep calls. |
| `IU_OPENAI_BASE_URL` | yes | — | slash-stripped | OpenAI-dialect upstream base (`.../openai/v1`). Used by transcriptions, speech, models, prep chat. |
| `IU_GEMINI_BASE_URL` | no (request-time) | `""` | slash-stripped | Native Gemini `generateContent` base (`.../gemini/v1beta`). Empty boots fine; throws at request time if a Gemini TTS request arrives. |
| `USAGE_DB` | no | `./data/usage.db` | string | SQLite usage-log path. Parent dir auto-created. |
| `PROXY_API_KEY` | no | `""` | string | If set, callers must send `Authorization: Bearer <it>`; empty = accept any (localhost posture). |
| `STT_LANGUAGE` | no | `""` | string | Hard ISO-639-1 lock injected into upstream STT only if client sent no `language`. |
| `STT_PROMPT` | no | `""` (code) | string | Soft language bias injected only if client sent no `prompt`. `.env.tpl`/launchd supply `"Die Aufnahme ist auf Deutsch oder Englisch."` |
| `TTS_PREP_MODEL` | no | `"DeepSeek-V4-Pro"` | string | OpenAI-dialect model that rewrites text into chunks. |
| `TTS_MP3_BITRATE` | no | `64` | `Number()` | MP3 output bitrate (kbps). |
| `TTS_CHUNK_THRESHOLD` | no | `700` | `Number()` | Input length below which prep short-circuits to default in `long` mode. |
| `TTS_CHUNK_TARGET_WORDS` | no | `110` | `Number()` | Preferred words/chunk when regrouping. |
| `TTS_CHUNK_MAX_WORDS` | no | `150` | `Number()` | Hard word ceiling → triggers re-split. |
| `TTS_CHUNK_MAX_BYTES` | no | `1800` | `Number()` | Hard UTF-8 byte ceiling/chunk (under Gemini's 4000-byte text limit). |
| `TTS_PREP` | no | `"always"` | `"always"\|"long"\|"off"` | `always` = LLM every request; `long` = LLM only when input ≥ threshold; `off` = never LLM. |

Port 7716 appears in three places (config default, the `dev` kill-port, the launchd wrapper) — keep in sync.

## 5. HTTP contract

Server: `Bun.serve({ port, idleTimeout: 255, fetch })`. `idleTimeout: 255`s is deliberate — long-clip
transcription can take minutes; preserve it.

Routing order:
1. `GET /health` (exact path, before auth) → `200` `{ ok: true, service: "audio-proxy" }`. **Rename the service string.**
2. Auth gate: if `PROXY_API_KEY` set and `Authorization` ≠ `Bearer <key>` → `401` `{ error: { message: "unauthorized", type: "invalid_request_error" } }`.
3. `POST *…/audio/transcriptions` (suffix match) → `handleTranscriptions`.
4. `POST *…/audio/speech` (suffix match) → `handleSpeech`.
5. `GET *…/models` (suffix match) → `handleModels`.
6. Any thrown error in 3–5 → `500` `{ error: { message, type: "proxy_error" } }`.
7. No match → `404` `{ error: { message: "no route for <METHOD> <path>", type: "not_found" } }`.

Routes match on **suffix** (`path.endsWith(...)`) so both `/v1/audio/...` and `/audio/...` work.

### POST /audio/transcriptions (STT)
- **Request**: `multipart/form-data`. Fields read: `model`, `response_format` (default `"json"`), `language`
  (optional), `file` (a `File`). Other fields pass through untouched.
- **Synth decision**: `synth = /transcribe/i.test(model) && response_format ∈ {verbose_json, srt, vtt}`.
- **Upstream form rebuild**: copy every field EXCEPT `response_format` and `timestamp_granularities[]` (stripped);
  append `response_format = synth ? "json" : clientFormat`. Inject `language=STT_LANGUAGE` only if client omitted
  it and config set; inject `prompt=STT_PROMPT` only if client omitted it and config set. Client values always win.
- **Upstream call**: `POST {iuBase}/audio/transcriptions` with `iuHeaders()` (no content-type — FormData sets boundary).
- **On upstream non-2xx**: record usage (status, latency, responseFormat=clientFormat, no usageJson) and return the
  upstream body verbatim with its content-type and status.
- **On success**: if upstream is JSON, extract `text`, `usage`, `language` (overrides detected). `recordUsage` with `usageJson: usage`.
- **Response shapes**:
  - synth + `verbose_json`: envelope `{ task:"transcribe", language, duration, text, segments:[{ id:0, seek:0, start:0, end:duration, text, tokens:[], temperature:0, avg_logprob:0, compression_ratio:1, no_speech_prob:0 }] }` (single segment spanning the clip).
  - synth + `srt`: `text/plain; charset=utf-8`, body `1\n<HH:MM:SS,mmm> --> <...>\n<text>\n`.
  - synth + `vtt`: `text/vtt; charset=utf-8`, body `WEBVTT\n\n<HH:MM:SS.mmm> --> <...>\n<text>\n` (comma → dot).
  - non-synth `json`: `{ text }`.
  - everything else (Whisper rich formats, plain text): upstream body verbatim with upstream content-type/status.
- **Duration**: `ffprobe` on a temp file `/tmp/audio-proxy-<uuid>` (rename prefix → `audio-gateway-`); parse
  `format=duration`; return `0` if ffprobe absent/fails. Temp file unlinked in `finally`.
- **`srtTime`**: `HH:MM:SS,mmm` zero-padded from seconds.

### POST /audio/speech (TTS)
- **Request**: JSON body read as text first, then `JSON.parse` in try/catch. Fields: `model`, `input`, `voice`,
  `response_format`. `inputChars = input.length`.
- **Dispatch**: `GEMINI_TTS = /gemini.*tts/i`. If `model` matches → `handleGeminiSpeech` (§6). Else passthrough.
- **Passthrough**: forward the **original raw body** to `POST {iuBase}/audio/speech` with
  `iuHeaders({ "content-type": "application/json" })`; read `arrayBuffer()`; record usage
  `{ endpoint:"speech", model, status, latencyMs, inputChars, bytesOut }`; return audio with upstream
  content-type or fallback `audio/mpeg`, upstream status.
- **Custom response header (Gemini path only)**: `X-Audio-Title: encodeURIComponent(title)` — URL-encoded
  because titles are often German (umlauts) and headers are ASCII-only. Clients decode it.

### GET /models
Passthrough: `GET {iuBase}/models` with `iuHeaders()`; return upstream body text, status, content-type
(fallback `application/json`). **Not logged to usage.**

## 6. Gemini expressive TTS pipeline

Decision made upstream in speech.ts via `/gemini.*tts/i` on the model name (e.g. `gemini-3.1-flash-tts-preview`).

**`handleGeminiSpeech`**:
1. **Preconditions**: throw if `iuGeminiBaseUrl` empty ("IU_GEMINI_BASE_URL is not configured — required for
   Gemini TTS"); return `400` JSON if `input` blank.
2. **Voice resolution**: `voiceName = VOICES.has(voice) ? voice : "Charon"`. Charon is the default/fallback, not
   forced. 30 hard-coded prebuilt voices — Male: Charon, Schedar, Iapetus, Algieba, Orus, Puck, Enceladus,
   Sadachbia, Rasalgethi, Sadaltager, Achird, Umbriel, Alnilam, Fenrir, Algenib, Zubenelgenubi; Female: Sulafat,
   Kore, Leda, Callirrhoe, Despina, Laomedeia, Gacrux, Pulcherrima, Vindemiatrix, Zephyr, Aoede, Autonoe,
   Erinome, Achernar.
3. **Prep** (`runPrep`): mode switch — `off` → `defaultPrep`; `long` && input < `TTS_CHUNK_THRESHOLD` →
   `defaultPrep`; else call the prep LLM: `POST {iuBase}/chat/completions` with `model = TTS_PREP_MODEL`,
   messages `[{role:"system", content: PREP_SYSTEM_PROMPT}, {role:"user", content: input}]`, and
   `max_completion_tokens = min(32000, max(2000, input.length + 1000))`. Uses `max_completion_tokens`
   **deliberately** (reasoning models reject `max_tokens`). Non-2xx → throw `TTS prep failed: HTTP <status> <body>`.
   Success → record a `speech-prep` usage row, then `parsePrepResponse(content)`.
   - `PREP_SYSTEM_PROMPT`: Hermes persona ("calm, warm, concise sharp older friend", no greetings). Tasks:
     detect lang de/en; write a 3–6-word title in the transcript language (no quotes/punctuation/emoji); rewrite
     numbers/times/dates/units to spoken form in that language (do NOT translate); split into ~110-word chunks
     (≤150, ~40–50 s each) at paragraph→sentence boundaries, never mid-sentence; per-chunk `style` directive +
     1–2 SPARSE inline performance tags. Tags — German `[pause] [nachdenklich] [lacht] [seufzt] [begeistert]
     [bestimmt] [flüsternd]`; English `[pause] [thoughtful] [chuckles] [sigh] [excited] [firm] [whispers]`.
     Output: STRICT JSON `{"lang":"de"|"en","title":"...","chunks":[{"style":"...","text":"..."}]}`.
   - `defaultPrep`: no LLM — `looksGerman()` heuristic picks lang/style; `fallbackTitle()` = first 6 words, or
     "Sprachnachricht"/"Voice memo"; single chunk with raw trimmed input.
   - `parsePrepResponse`: strip ```` ```json ```` fences, extract first `{`…last `}`, JSON-parse. Throw on no
     object / empty chunks / chunk missing text. Missing `style`/`title` default to `""`.
4. **Chunk-limit enforcement** (`enforceChunkLimits`): applied regardless of how the LLM split. Chunks within both
   hard ceilings (`maxWords`, `maxBytes`) pass through untouched (preserving inline tags); over-long chunks are
   `atomize`d — paragraphs (`\n{2,}`) → sentences (`(?<=[.!?…])\s+`) → last-resort word-split — then `pack`ed
   greedily toward `targetWords`. Limits: `{ targetWords: 110, maxWords: 150, maxBytes: 1800 }`.
5. **Per-chunk synth** (`synthChunk`): in audio-proxy this is a **sequential** `for` loop (NO concurrency knob).
   *(PRD Decision 1 changes this to concurrent, order-preserving, default 4.)* Each call:
   `POST {geminiBase}/models/{model}:generateContent` with `iuHeaders({content-type: application/json})` and body:
   ```json
   { "contents":[{"parts":[{"text":"<chunk.style>: <chunk.text>"}]}],
     "generationConfig":{ "responseModalities":["AUDIO"], "temperature":1.0,
       "speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":"<voiceName>"}}} } }
   ```
   Style directive prepended inline as `"<style>: <text>"`. Response: base64 in
   `candidates[0].content.parts[0].inlineData.data`; sample rate from `inlineData.mimeType` via `/rate=(\d+)/`,
   default 24000. Audio is **L16 / s16le PCM, 24 kHz, mono**. Throw on non-2xx (`Gemini TTS failed: ...`) or
   missing audio (`Gemini TTS returned no audio: ...`). Record a `speech` usage row per chunk:
   `{ endpoint:"speech", model, status, latencyMs, inputTokens: usageMetadata.promptTokenCount,
   outputTokens: usageMetadata.candidatesTokenCount, audioSeconds: pcm.byteLength/(2*sampleRate), bytesOut }`.
6. **Concat** (`concatPcm`): join s16le PCM with `SILENCE_MS = 400` ms of zeroed silence between chunks
   (`round(0.4*sampleRate)*2` bytes per gap, 16-bit mono). Sample rate from the first chunk.
7. **Transcode** (`transcode`): `Bun.spawn` ffmpeg `-hide_banner -loglevel error -f s16le -ar <rate> -ac 1 -i
   pipe:0 <codec> pipe:1`. Codec: default MP3 `-c:a libmp3lame -b:a <TTS_MP3_BITRATE>k -f mp3` → `audio/mpeg`;
   `response_format === "opus"` → `-c:a libopus -b:a 32k -f ogg` → `audio/ogg` (opus 32k hard-coded). Read
   stdout/stderr concurrently with the stdin write to avoid pipe deadlock; non-zero exit throws.
8. **Response**: `200`, content-type per codec, `X-Audio-Title: encodeURIComponent(prep.title ||
   fallbackTitle(input, prep.lang==="de"))`.

`pcmToWav` writes a 44-byte WAV header (mono/16-bit) — **unused** by the ffmpeg path, kept as a documented
fallback and tested. `SAMPLE_RATE_DEFAULT = 24000`.

`rawFetch`: retry helper, `attempts=3`, retries on **503/429** with linear backoff `Bun.sleep(500*attempt)`.
Used by `runPrep` and `synthChunk`. Plain passthrough STT/TTS do NOT retry (single fetch).

## 7. usage.ts (SQLite)

- **DB path**: `config.usageDb` (default `./data/usage.db`). Parent dir auto-created. Opened `{ create: true }`,
  `PRAGMA journal_mode = WAL`.
- **Table** `usage_record` (`CREATE TABLE IF NOT EXISTS`):
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `ts` TEXT NOT NULL — ISO-8601
  - `endpoint` TEXT NOT NULL — `'transcriptions' | 'speech' | 'speech-prep'` (drop the dead `'models'`)
  - `model` TEXT NOT NULL
  - `status` INTEGER NOT NULL — upstream HTTP status
  - `latency_ms` INTEGER NOT NULL
  - `response_format` TEXT (nullable) — STT requested format
  - `input_tokens` INTEGER (nullable)
  - `output_tokens` INTEGER (nullable)
  - `audio_tokens` INTEGER (nullable)
  - `audio_seconds` REAL (nullable)
  - `input_chars` INTEGER (nullable) — TTS input length
  - `bytes_out` INTEGER (nullable) — TTS audio size
  - `usage_json` TEXT (nullable) — raw upstream usage object, JSON-stringified
- **Index**: `CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_record (ts)`.
- **`recordUsage(row)`**: insert via prepared stmt. `tokens()` derives counts from `usageJson` when explicit
  fields absent: `input = input_tokens ?? prompt_tokens`; `output = output_tokens ?? completion_tokens`;
  `audioTokens = input_token_details.audio_tokens`; `audioSeconds = prompt_audio_seconds`. Explicit row fields
  win. `usage_json` stored only if truthy.

**What each route writes**:
- transcriptions: `endpoint:"transcriptions"`, `model`, `status`, `latencyMs`, `responseFormat:clientFormat`;
  on success also `usageJson:usage`. On upstream error, no usageJson.
- speech (passthrough): `endpoint:"speech"`, `model`, `status`, `latencyMs`, `inputChars`, `bytesOut`.
- speech (Gemini, per chunk): `endpoint:"speech"`, `model`, `status`, `latencyMs`, `inputTokens`, `outputTokens`,
  `audioSeconds`, `bytesOut`. One row per chunk.
- speech-prep: `endpoint:"speech-prep"`, `model:ttsPrepModel`, `status`, `latencyMs`, `inputChars`,
  `usageJson:json.usage`. One row per Gemini TTS request that calls the prep LLM.

## 8. Deployment today

**macOS LaunchAgent** — `launchd/com.jkrumm.audio-proxy.plist.template`, rendered (`sed s/__HOME__/$HOME/`) to
`~/Library/LaunchAgents/com.jkrumm.audio-proxy.plist`:
- `Label`: `com.jkrumm.audio-proxy` → rename to `com.jkrumm.audio-gateway`.
- `ProgramArguments`: `<HOME>/SourceRoot/audio-proxy/launchd/start-audio-proxy.sh` → new repo path + script name.
- `EnvironmentVariables`: `PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, `HOME=<HOME>`.
- `WorkingDirectory`: `<HOME>/SourceRoot/audio-proxy` → new repo path.
- `RunAtLoad`: true, `KeepAlive`: true.
- `StandardOutPath`: `/tmp/audio-proxy.log`, `StandardErrorPath`: `/tmp/audio-proxy.err` → rename.

**install-agent.sh**: `set -euo pipefail`; compute REPO from script dir; `mkdir -p ~/Library/LaunchAgents`;
`chmod +x` the start script; `sed` the template into the plist; `launchctl unload` (ignore errors) then
`launchctl load`. Idempotent.

**start-audio-proxy.sh** (`set -u`): launchd cannot run `op` (no biometric session), so secrets come from
**macOS Keychain**:
- `KEY = security find-generic-password -s claude-sdk-api-key -w`
- `BASE = security find-generic-password -s claude-sdk-base-url -w` (slash-stripped); the IU Anthropic transport
  ending in `/anthropic`.
- Exit 1 if either missing.
- Derive: `IU_API_KEY=$KEY`; `IU_OPENAI_BASE_URL=${BASE%/anthropic}/openai/v1`;
  `IU_GEMINI_BASE_URL=${BASE%/anthropic}/gemini/v1beta`; `PORT=${PORT:-7716}`;
  `USAGE_DB=${USAGE_DB:-$REPO/data/usage.db}` (absolute); `STT_LANGUAGE=${STT_LANGUAGE:-}`;
  `STT_PROMPT=${STT_PROMPT:-Die Aufnahme ist auf Deutsch oder Englisch.}`.
- `cd "$REPO"`; `exec /opt/homebrew/bin/bun "$REPO/src/index.ts"` (foreground exec so launchd keeps the PID).

**Secrets injection**:
- Dev: `op run --account tkrumm --env-file=.env.tpl` resolves `op://common/anthropic/{OPENAI_BASE_URL,API_KEY,GEMINI_BASE_URL}`.
- Mac prod (launchd): Keychain entries `claude-sdk-api-key` + `claude-sdk-base-url`.
- VPS prod (NEW, Phase 2): env injected by compose; no Keychain.

## 9. Behavioral quirks to preserve

- Route suffix matching — both `/v1/...` and `/...` work.
- `idleTimeout: 255`s — required for long transcriptions.
- STT format synth only for `/transcribe/i` models; Whisper passes rich formats through untouched. Synthesized
  verbose_json/srt/vtt is a single block spanning the clip; `ffprobe` gives best-effort duration (`0` if absent).
- `timestamp_granularities[]` stripped before forwarding.
- Language steering injected only when client omits; client always wins. Shipped default prompt (via env tpl +
  launchd) = `Die Aufnahme ist auf Deutsch oder Englisch.` to hold gpt-4o-transcribe on DE/EN.
- TTS prep persona: Hermes "calm, warm, sharp older friend"; numbers→spoken in source language; never translate;
  sparse (1–2) inline performance tags per chunk.
- Chunking rationale — ~45 s/chunk because Gemini TTS quality drifts past ~60 s in a single generation;
  `enforceChunkLimits` is a hard backstop independent of the LLM's split.
- `X-Audio-Title` URL-encoded title header (German umlauts); clients decode it to name files/attachments.
- Retry: only the Gemini pipeline (`rawFetch`) retries 503/429 (3 attempts, 500ms·n). Plain passthrough does not.
- 400 ms zeroed silence between chunks.
- `response_format=opus` → libopus 32k OGG; otherwise MP3 at configured bitrate.
- `max_completion_tokens` (not `max_tokens`) in the prep call — reasoning models reject the legacy field.
- `temperature: 1.0` on Gemini synth — intentional for expressive variety.
- No-audio = loud failure: a chunk with no audio throws (no silent partial output).
- `IU_API_KEY` reused for OpenAI, Gemini, and prep calls (one bearer token).

## 10. Known bugs to FIX in the rebuild (do NOT port as-is)

1. **Gemini synth/prep error path throws before `recordUsage` → failures log no usage.** In `synthChunk` and
   `runPrep`, a non-2xx upstream or missing-audio response throws *before* any usage row is written; only the
   generic 500 wrapper catches it. Net: failed Gemini chunks/prep leave ZERO usage rows, unlike the STT path which
   records a row even on upstream error. **Fix**: record a usage row (error status/latency) before throwing.
2. **Dead `endpoint:"models"` enum value.** Declared in the schema comment and `UsageRow.endpoint` union, but
   `handleModels` never calls `recordUsage`. **Fix**: drop the enum member (preferred) or log `/models`.
3. **Non-JSON `/audio/speech` body → blank-model usage row.** If `JSON.parse` throws, the catch leaves `model=""`,
   `inputChars=0`, still forwards the raw body, and writes a misleading empty-model usage row. **Fix**: respond
   `400` JSON on non-JSON body; do not write the row.

## Rename checklist for audio-gateway

package name; `/health` `service` string; startup log line; LaunchAgent Label + plist filename + log paths +
repo path (`SourceRoot/audio-proxy` → `SourceRoot/audio-gateway`); the `/tmp/audio-proxy-<uuid>` ffprobe temp
prefix → `audio-gateway-`; Keychain-derivation comments; `.env.tpl` header. KEEP shared infra: the
`op://common/anthropic/*` references and Keychain keys `claude-sdk-api-key` / `claude-sdk-base-url`.
