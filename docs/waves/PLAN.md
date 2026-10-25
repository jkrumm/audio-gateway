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

## Wave 1 — Expertise + voice audition            <!-- status: active -->
- [ ] `/research` (deep) Gemini 3.8 TTS: official speech-generation docs, API reference for every
      `SpeechConfig`/style field, release notes, voices (30 prebuilt + Extended Library, voice design),
      streaming, multi-speaker, limits, pricing; plus what practitioners report (forums, GitHub issues,
      blog tests): prompting that works, tag vocabulary, German quality, long-form drift, truncation,
      directions read aloud, voice consistency across chunks, pacing/speed control without a speed param
- [ ] IU probe matrix (cheap, short texts): which documented fields/tags/formats actually work through
      IU — style field variants and placement, `<tag>` vs `[tag]`, pauses, multi-speaker, output formats,
      sample rates, temperature/seed, voice list / voice design endpoints, max chunk length before drift.
      Record request + result for each
- [ ] Rewrite modelpick `docs/gemini-tts.md` into the 3.8 expert reference (request shapes per lane,
      style control, tag vocabulary, multi-speaker, streaming, limits, German tips, IU-vs-docs table,
      traps). This is the doc every later wave follows; audio-gateway and Hermes link to it
- [ ] Voice audition in modelpick `/tts` (reuse `scripts/tts-compare.ts` + manifest): German briefing +
      podcast text, Charon vs the 4–5 most suitable other male voices, and every plausible female voice
      for podcast host B (pairs with Charon in a multi-speaker excerpt). Blind mode, cost per sample
- [ ] Close out; **Left behind** must list the female-voice shortlist and say the owner picks before W3
**Left behind:**

## Wave 2 — audio-gateway chat + briefing lanes on 3.8            <!-- status: pending -->
- [ ] Gemini lane to 3.8 conventions per `docs/gemini-tts.md`: no spoken style prefix; style via the
      field/tags that W1 proved on IU; prep prompt rewritten for the 3.8 tag vocabulary; voice Charon
- [ ] Streaming: `/v1/audio/speech` passes Gemini PCM through progressively (chunked) for clients that
      read progressively (`response_format: pcm`, and mp3 if feasible); whole-file path unchanged
- [ ] Lane routing: chat → `gemini-3.8-flash-lite-tts` (prep off), briefing → `gemini-3.8-flash-tts`
      (prep on); usage rates in `src/usage.ts`; ElevenLabs lane kept as fallback by model id
- [ ] Tests, `make check`, `/review`; push (no podcast job running); verify on prod: first-byte latency,
      German output via `gpt-transcribe` round trip, HyperDX trace, usage rows
**Left behind:**

## Wave 3 — Podcasts on 3.8 multi-speaker            <!-- status: pending -->
- [ ] Owner-chosen co-host voice in config; script writer emits the 3.8 tag vocabulary instead of v3 tags
- [ ] Synth via `multiSpeakerVoiceConfig` in chunks within the token limits, keeping chapter timestamps,
      per-host loudness and pacing (replace v3 `speed` with what W1 found works)
- [ ] Tests, `make check`, `/review`; `make deploy` on the mini; one short test episode published to
      Audiobookshelf for the owner to listen to; cost recorded
**Left behind:**

## Wave 4 — Cutover + one source of truth            <!-- status: pending -->
- [ ] Hermes (`~/SourceRoot/hermes-agent` config + `skills/briefing-tts`, applied to the live install the
      way that repo's AGENTS.md prescribes): chat model/voice, streaming settings so desktop + CLI voice
      start early, briefing model; SOUL/skill docs updated
- [ ] modelpick: `MY_STACK` tts pick, `src/db/deployments.ts` rows, `bun run verify-deployments --update`,
      decision record verdict section
- [ ] audio-gateway AGENTS.md/README/docs, Hermes AGENTS.md: point at `docs/gemini-tts.md`
- [ ] End-to-end through Hermes: desktop speak-stream first PCM, CLI voice, Slack whole-file reply,
      a briefing, the podcast skill — numbers recorded in the decision record
**Left behind:**
