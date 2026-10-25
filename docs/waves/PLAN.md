# Gemini 3.8 TTS cutover — chat, briefings, podcasts
**Goal:** every TTS lane (Hermes chat replies, briefings, two-host podcasts) runs on Gemini 3.8 TTS with
voice Charon, used the way the model is documented and reported to work best — streaming where the client
can use it — and audio-gateway, Hermes and modelpick all describe and verify the same setup.
**Gate:** `make check` (audio-gateway), `/review` on every non-trivial change, then the wave's own live
verification. One wave is active at a time; this plan runs **orchestrated** — the orchestrator tab spawns
each wave after reviewing the previous close-out. Do not spawn the next wave yourself.

## Established — do not re-derive
Evidence: modelpick `docs/decisions/audio-stack.md` §"TTS field re-check (2026-10-25)" and the German
comparison section after it (commits df147cc, cb5909e); 62 samples on modelpick `/tts`
(`data/tts-compare/manifest.json`, `scripts/tts-compare.ts`).

- **Owner decision (2026-10-25):** switch to Gemini 3.8. Main voice **Charon** (preferred over Rasalgethi).
  Podcast co-host: **Sulafat is only lukewarm** — audition female alternatives (Wave 1) before Wave 3.
- Models: `gemini-3.8-flash-lite-tts` (chat; AA #8, ~$0.009/min, first audio 0.5–0.8 s streamed),
  `gemini-3.8-flash-tts` (briefings + podcasts; AA #5, ~$0.0135/min through 2026-12-31 then 2×,
  first audio 0.6–1.1 s). Both GA 2026-09-22. ElevenLabs v3 was AA #21; v4 is not on Replicate.
- IU route: native `POST {IU_GEMINI_BASE_URL}/models/<m>:generateContent` and
  `:streamGenerateContent?alt=sse` (base64 PCM 24 kHz s16le). OpenAI `/audio/speech` 404s for Gemini.
- **Verified traps on IU:** a `"Style: text"` prefix (the 3.1 convention the current `gemini-tts.ts`
  prep produces) is **read aloud** by 3.8; `systemInstruction` → 400 "Developer instruction is not enabled
  for this model"; `generationConfig.speechConfig.speechMetadata` → "Unknown name"; inline `[friendly]`
  tags work. Docs (per research, unconfirmed on IU) put sustained style in a `speech_metadata.style`
  field and reserve `<laugh>`, `<sigh>`, `<breath>`, `<short pause>`, `<long pause>`… for vocal events;
  2-speaker `multiSpeakerVoiceConfig` (prebuilt voices only); 8,192 input / 16,384 output tokens.
- Hermes streaming (`~/.hermes/hermes-agent`, the live install; `~/SourceRoot/hermes-agent` holds config +
  patches): CLI voice + desktop `speak-stream` read the gateway response progressively
  (`tools/tts_streaming.py:316`, `audio.py:891`); Slack/file replies wait for the whole body
  (`tools/tts_tool_openai.py:157`). Today Hermes `config.yaml` `tts.openai` points at the gateway with
  `elevenlabs/flash-v2.5` / voice `Mark`; briefings via `skills/briefing-tts` on `elevenlabs/v3`.
- audio-gateway already has a Gemini lane (`src/gemini-tts.ts`, `gemini-tts-core.ts`, prep LLM →
  `{style,text}` chunks → per-chunk synth → ffmpeg) built for 3.1. The ElevenLabs/Replicate lane stays as
  a fallback, selectable by model id. Podcast synth (`podcast-synth.ts`, `podcast-script.ts`) is built on
  v3 audio tags + per-host `speed` (0.94 / 1.0) + stability 0.5.
- Ops: push to `master` redeploys the VPS via CI; the mini (podcasts, :7719) deploys with `make deploy`,
  which refuses while a podcast job runs. Never push or deploy while a podcast job runs
  (`GET /v1/podcasts` on both). audio-gateway is direct-to-master. Secrets via `secrets-run`.
- Spend: IU tokens. Caps: W1 $1, W2 $1, W3 $4 (one test episode), W4 $0.5. Report actual spend.

## Wave 1 — Expertise + voice audition            <!-- status: done -->
- [x] `/research` (deep) Gemini 3.8 TTS: official speech-generation docs, API reference for every
      `SpeechConfig`/style field, release notes, voices (30 prebuilt + Extended Library, voice design),
      streaming, multi-speaker, limits, pricing; plus what practitioners report (forums, GitHub issues,
      blog tests): prompting that works, tag vocabulary, German quality, long-form drift, truncation,
      directions read aloud, voice consistency across chunks, pacing/speed control without a speed param
- [x] IU probe matrix (cheap, short texts): which documented fields/tags/formats actually work through
      IU — style field variants and placement, `<tag>` vs `[tag]`, pauses, multi-speaker, output formats,
      sample rates, temperature/seed, voice list / voice design endpoints, max chunk length before drift.
      Record request + result for each
- [x] Rewrite modelpick `docs/gemini-tts.md` into the 3.8 expert reference (request shapes per lane,
      style control, tag vocabulary, multi-speaker, streaming, limits, German tips, IU-vs-docs table,
      traps). This is the doc every later wave follows; audio-gateway and Hermes link to it
- [x] Voice audition in modelpick `/tts` (reuse `scripts/tts-compare.ts` + manifest): German briefing +
      podcast text, Charon vs the 4–5 most suitable other male voices, and every plausible female voice
      for podcast host B (pairs with Charon in a multi-speaker excerpt). Blind mode, cost per sample
- [x] Audition renders the real pipeline, not plain text (owner addendum): for every auditioned voice render
      the SAME German material three ways — (1) a chat reply as the chat lane sends it, (2) a briefing
      passage after the 3.8-correct prep (spoken-form numbers, chunking, the style/tag mechanism the probe
      matrix proved), (3) a podcast excerpt with expression (emotion/pacing tags, pauses, a laugh or sigh, a
      question, an emphatic line) as multi-speaker with Charon. Same text + tags across voices. Each manifest
      sample carries the exact request (style field/tags) so the page shows it. Stay in the $1 cap; cut
      voices, not lanes
- [x] Close out; **Left behind** must list the female-voice shortlist and say the owner picks before W3
**Left behind:**
- **Reference:** modelpick `docs/gemini-tts.md` (f6d9455) — every claim tagged docs / IU / field, with a docs-vs-IU field map. Follow it; do not re-probe.
- **What W2 must apply (IU-proven):** style goes in `parts[].speechMetadata.style` (short string, not spoken, measurably changes pace); the `"Style: text"` prefix is spoken/garbled — delete it from prep. Tags are angle brackets (`<short pause>`, `<long pause>`, `<laugh>`, `<sigh>`), never spoken. Unary returns WAV (strip 44 bytes) or raw PCM via `generationConfig.responseFormat.audio.mimeType: "AUDIO_L16"`; stream returns headerless `audio/l16` 24 kHz (`?alt=sse` or array framing both work); no MP3 (ffmpeg). Streamed `usageMetadata` reports 1 token — bill from duration × 25. Multi-speaker needs per-part `speechMetadata.speaker`; `Name:` prefixes 400. `systemInstruction`/`speechConfig.speechMetadata` 400; `temperature`/`seed` accepted but unproven.
- **Chunking:** distinct German text is faithful to ~1,057 chars / 57 s per request (word count within 3 %). Repeated identical text makes the model skip most of it (test artefact). Rule used: sentence-aligned chunks ≤ ~1,000 chars, same short style per chunk, 250 ms silence join.
- **Not on IU:** Extended Voice Library (`GET /voices` 500), voice design (`POST /voices` 405), Interactions API (405). The 30 prebuilt voices are the catalogue.
- **Audition:** modelpick `/tts` → "Gemini 3.8 voice audition" (157e780), 41 samples, blind mode, each row shows its exact request. Chat = flash-lite raw; briefing = prototype prep (`scripts/tts-audition.ts` holds the contract) on flash; podcast = multi-speaker with per-turn style + `<short pause>`/`<long pause>`/`<laugh>`/`<sigh>`/CAPS emphasis. Males: Charon, Rasalgethi, Sadaltager, Iapetus, Algieba, Achird (alternatives pair with Sulafat). Tags were never spoken; transcript round trip verbatim on nearly all rows (chat "diffs" are digit/"Uhr" normalisation).
- **Female shortlist for podcast host B (all paired with Charon):** Sulafat (current, lukewarm), Vindemiatrix, Kore, Despina, Gacrux, Erinome, Callirrhoe, Laomedeia. **The owner picks the co-host voice (and confirms Charon vs the male alternatives) by listening before W3 starts; W2 only needs Charon.**
- **Spend vs cap — over by ~$0.45:** research $0.91 (two deep runs: $0.42 + $0.49), IU probes ~$0.17, audition ~$0.38 (TTS $0.23 + STT round trips) ≈ **$1.46 vs the $1 cap**. The deep research alone was the overrun; W2–W4 caps unchanged but W2 needs no research.
- Gate: modelpick `tsc --noEmit` clean, oxlint warnings only (no-console in scripts, pre-existing style). No `/review` run on the modelpick diff (script + page section + doc, no shared path).

## Wave 2 — audio-gateway chat + briefing lanes on 3.8            <!-- status: done -->
- [x] Gemini lane to 3.8 conventions per `docs/gemini-tts.md`: no spoken style prefix; style via the
      field/tags that W1 proved on IU; prep prompt rewritten for the 3.8 tag vocabulary; voice Charon
- [x] Streaming: `/v1/audio/speech` passes Gemini PCM through progressively (chunked) for clients that
      read progressively (`response_format: pcm`, and mp3 if feasible); whole-file path unchanged
- [x] Lane routing: chat → `gemini-3.8-flash-lite-tts` (prep off), briefing → `gemini-3.8-flash-tts`
      (prep on); usage rates in `src/usage.ts`; ElevenLabs lane kept as fallback by model id
- [x] Tests, `make check`, `/review`; push (no podcast job running); verify on prod: first-byte latency,
      German output via `gpt-transcribe` round trip, HyperDX trace, usage rows
**Left behind:**
- **Shipped** (6091221 + span fix, pushed, VPS deploy green): Gemini lane on 3.8 — `speechMetadata.style` (no spoken prefix), unary asks `AUDIO_L16`, no `temperature`; prep prompts rewritten (≤~1,000-char sentence-aligned chunks, constant `PREP_STYLE` "calm, warm, conversational", `<short pause>`/`<long pause>`/`<laugh>`/`<sigh>`, spoken-form numbers; a prep style over 60 chars is replaced). Default `TTS_MODEL` = `gemini-3.8-flash-lite-tts` (prep off, deterministic `normalizeForSpeech` only); `TTS_GEMINI_PREP_MODELS` = `gemini-3.8-flash-tts` (prep on). `TTS_PREP`/`summarize` gating unchanged on top. `TTS_CHUNK_MAX_BYTES` 1800 → 1100. ElevenLabs lane untouched, still selected by `owner/name` id. Rates in `src/usage.ts` (lite 0.5/6, flash 0.5/9 per 1M, intro through 2026-12-31). 3.1 rate row kept until its 2026-11-17 shutdown.
- **Streaming:** `response_format: pcm` → `streamGenerateContent?alt=sse`, sample-aligned passthrough, 400 ms silence join, pull-based backpressure (256 KiB), 60 s idle guard, 429/503 + transport retry before the first byte, in-band error / unparseable event fails the stream. Pre-first-byte failure = normal HTTP error; later = aborted chunked body. Billed from duration × 25 tokens/s. `streamSettled(response)` (WeakMap) lets `speech.ts` record the `speech-request` row when the body ends and `index.ts` hold the shutdown drain. **mp3 is NOT streamed** (decision: Slack/file clients need a complete body + `X-Audio-Title`; a progressive reader asks for pcm). W3/W4: Hermes streaming clients must send `pcm`.
- **Prod verification (VPS, no bearer needed):** lite pcm TTFB 0.73 s, total 1.8 s for 8 s of audio; flash + prep TTFB 2.7 s (prep LLM ~2 s dominates), total 4.5 s. `gpt-transcribe` round trip: German verbatim both models (digits/"Uhr" normalised by STT only). HyperDX: `audio.speech` + child `audio.synth.stream` (`audio.first_byte_ms` 641 / 991 ms), usage rows with `audio_seconds` + tokens = seconds × 25, `tts.first_byte` log. Whole-file mp3 still returns `audio/mpeg` + `X-Audio-Title`.
- **Review:** two `/review` passes; fixed shutdown drain, chunk status on failure/cancel, backpressure, SSE error/garbled events, idle guard, retry hint/transport retry, markdown normalisation on the no-prep path, root-span enrichment. Left as is (judgement): explicit `{response, settled}` return instead of the WeakMap; header-wait timeout on stream open (idle rule only); `audio.speech` span duration for streams is handler time (stream time is on the child span); senior-dev/concurrency angles failed to run (shell denied) in both passes.
- **Spend:** ~$0.03 (two live probes + three prod requests + STT round trips) vs $1 cap.
- **Not done / for W3:** the mini was not redeployed (podcasts use ElevenLabs v3 until W3; `make deploy` there with W3). Podcast `PODCAST_TTS_MODEL` unchanged. Owner confirmed Charon as main voice; the **co-host voice pick is still open and must be made before W3 starts** (shortlist in W1 Left behind).

## Wave 3 — Hermes cutover: chat + briefings            <!-- status: done -->
Reordered by the orchestrator (2026-10-25): the podcast co-host voice is still with the owner, the Hermes
chat/briefing cutover does not depend on it.
- [x] Hermes (`~/SourceRoot/hermes-agent` config + `skills/briefing-tts`, applied to the live install
      `~/.hermes/hermes-agent` the way that repo's AGENTS.md prescribes): chat → `gemini-3.8-flash-lite-tts`
      / `Charon`, briefing → `gemini-3.8-flash-tts` / `Charon`; streaming clients (CLI voice
      `tts_streaming.OpenAIStreamer`, desktop `speak-stream` relay) request `response_format: pcm` so
      they get the progressive stream; Slack/file stay whole-file mp3 (`X-Audio-Title`). Check the
      summary path (`summarize: true`, `voice.speak_summary_min_chars`) still works on the new model
- [x] Docs: Hermes AGENTS.md / SOUL TTS notes / skill docs name the new models, link modelpick
      `docs/gemini-tts.md`; audio-gateway AGENTS.md/README point at it too
- [x] End-to-end through Hermes (the 2026-08-26 validation table in modelpick `audio-stack.md` is the
      template): desktop speak-stream first PCM, CLI voice streamer per sentence, Slack whole-file reply
      with title, a briefing via `skills/briefing-tts` — numbers recorded for W4's decision record
- [x] Gate (`make check` where code changed, `/review` on non-trivial changes), commits, push. Spend cap $0.5
**Left behind:**
- **Shipped** (hermes-agent 43a0ce4, pushed): `config.yaml` `tts.openai` → `gemini-3.8-flash-lite-tts` / `Charon` (live at once via the symlink; no restart needed — `load_config` picks it up). Streaming clients already sent `response_format: pcm` (`OpenAIStreamer`, the speak-stream relay, `_stream_speech_summary`), so no code or patch change. AGENTS.md, SOUL.md TTS rules, `skills/briefing-tts` (now `gemini-3.8-flash-tts` / Charon, ElevenLabs noted as fallback) and the cron prompt wording name the new setup and link modelpick `docs/gemini-tts.md`. audio-gateway README/AGENTS.md already linked the reference (W2) — no change.
- **Cron briefings now on `gemini-3.8-flash-tts` (orchestrator decision, hermes-agent follow-up commit):** the morning/evening cron prompts' Step 4 no longer calls `text_to_speech`; it runs the `briefing-tts` skill's urllib pattern via `terminal` (`gemini-3.8-flash-tts`, Charon, prep + title, mp3, filename per the skill conventions). Same edit in the live `cron/jobs.json` (untracked; prompts there were already whitespace-different from the `.prompt.txt` files) — takes effect on the next 07:00 / 22:00 run, not yet exercised by a real cron run. Verified by running the prompt's own snippet: 9.2 s, 19.5 s audio, title "Tagesplan und Statusbericht", `gpt-transcribe` round trip correct (numbers spoken as digits by STT only).
- **E2E through Hermes' own code** (venv python, prod gateway, `gpt-transcribe` round trip verbatim): CLI streamer sentence 1 — first PCM 1.46 s (cold), 0.58 s (warm), total 0.8–2.0 s for 1.6–3.8 s of audio; spoken-summary path (`summarize: true`) first PCM 1.40 s, 12.7 s of audio, content a correct 2-sentence German condensation; Slack/file path `_generate_openai_tts` whole mp3 in 2.4 s, `X-Audio-Title` present even on lite ("Kurze Bestätigung"); briefing (`gemini-3.8-flash-tts`, prep on) 9.2 s for ~30 s of audio, title "Termine Wetter und Serverstatus", numbers spoken as "9:30". One STT pass dropped "Guten Morgen"; two re-runs had it — STT artefact.
- **Not exercised live:** the desktop WebSocket (`speak-stream`) end to end and a real Slack post — both use the same streamer / tool function tested above. No `/review` (config + docs only, no code).
- **Spend:** ~$0.03 vs $0.5 cap. Podcast co-host voice pick is still open for W4.

## Wave 4 — Podcasts on 3.8 multi-speaker + one source of truth            <!-- status: done -->
- [x] Co-host voice: owner picked **Erinome** (2026-10-25), host A stays **Charon**. Config + script writer emits the
      3.8 tag vocabulary instead of v3 tags
- [x] **C2PA bug (found by the owner's ear, 2026-10-25):** a 3.8 unary WAV carries a trailing `C2PA` chunk (~6 KB,
      content credentials) after `data`; code that strips 44 bytes and keeps the rest plays it as ~0.13 s of loud
      noise. Prod is clean today only because unary asks `AUDIO_L16`. Make `stripWavHeader` (`src/gemini-tts.ts`)
      parse RIFF chunks and return only the `data` chunk, with a test; podcast synth must use `AUDIO_L16` or the
      same parser. Note the trap in modelpick `docs/gemini-tts.md` and fix `scripts/tts-audition.ts` (`wavPcm`)
- [x] Synth via multi-speaker (per-part `speechMetadata.speaker`, see `docs/gemini-tts.md`) in chunks within
      the limits, keeping chapter timestamps, per-host loudness and pacing (replace v3 `speed` with the
      style-driven pace W1 measured)
- [x] Tests, `make check`, `/review`; `make deploy` on the mini (no job running); one short test episode
      published to Audiobookshelf for the owner to listen to; cost recorded. Spend cap $4
- [x] modelpick: `MY_STACK` tts pick, `src/db/deployments.ts` rows, `bun run verify-deployments --update`,
      decision record verdict section with W3's end-to-end numbers and the episode
**Left behind:**
- **Shipped** (audio-gateway f2b50f4, modelpick 3f6ffd5, both pushed; mini redeployed with no job running): podcast default `gemini-3.8-flash-tts`, voices Charon + Erinome, `unitsForMultiSpeaker` runs (<= 3000 chars, never across a segment) as one two-speaker request each (`synthMultiSpeaker`, `AUDIO_L16`); writer/editor prompts and `sanitizeTurns` use the angle-bracket 3.8 tags (`PODCAST_TAGS`, legacy `[v3]` tags stripped; `stripMarkdown` no longer eats `>`). ElevenLabs per-turn lane kept, selected by an `owner/name` model id (voice default follows the lane).
- **C2PA fixed:** `stripWavHeader` walks RIFF chunks and returns only `data` (tests with a trailing 6 KB chunk, odd padding, raw passthrough, no-data throw). Trap noted in modelpick `docs/gemini-tts.md` §IU-vs-docs #7; `scripts/tts-audition.ts` `wavPcm` fixed. The test episode's tail level matches its body (no noise spike).
- **Test episode** (Audiobookshelf "Brain Sonderausgabe", "Ein Gateway vor den Modellen", 3:07, 14 turns, 3 chapters): $0.78 all-in. **The owner still has to listen** — co-host pairing, pacing and the unmeasured WPM on 3.8 (`WORDS_PER_MINUTE` 140 is the v3 figure) are ear calls.
- **Trade-offs to know:** host loudness is levelled per run, not per host (runs hold both voices); dense turns slow via the style string "speaking slowly and clearly" only. Review (gateway, clean): applied voice-default-by-lane, no retry on 4xx, run label by distinct speakers; left as is: the run-first-text gap proxy (gap keys on the NEXT run's first turn, which is correct), the `synthesizeEpisode` extraction. senior-dev angle did not run.
- **modelpick:** `tts` stack pick -> `gemini-3.8-flash-lite-tts`; deployments rows (hermes tts, tts-default, podcast-tts) updated, `verify-deployments --update` stamped; 5 unrelated rows were already broken (claude-code interactive-iu, agent-gateway adversary/dispatch_implement(+escalation), hermes vision) — untouched. Decision record has the verdict section with W3's numbers and the episode. The modelpick commit also swept in a pre-existing uncommitted `docs/waves/PLAN.md` edit.
- **Spend:** ~$0.8 (episode $0.78 + a few probes) vs $4 cap.
- **stopped: plan complete** — last wave, no next wave spawned.
