# Podcast quality — expressive voice, real context, fair writer rematch
**Goal:** Johannes hears podcasts that use Gemini 3.8's expressiveness on purpose (deterministically checked), whose
writers get the context a stranger-listener needs, and he picks the voice owner from a fair blind rematch of
IU-only models on `/tts` — with a cost-per-episode next to each.
**Why:** owner verdict 2026-10-26 on the first bake-off: couldn't tell the writers apart; GLM, Kimi and Grok are out
(Grok would be self-paid — not worth it); no OpenRouter. He suspects context, expression use and segmentation matter
more than the model — the evidence below agrees.
**Gate:** `make check` here; modelpick `make check`, `make deploy`, `make verify`. **IU cap $4, enforced before every
call** (Wave 1 overran because it checked per candidate). Never push or `make deploy` audio-gateway while a podcast job
runs. **Writer default stays `claude-opus-5-5`** until the owner's blind verdict.

## Established — do not re-derive
- Previous plan (bake-off + learn-and-improve) is done; see git history of this file and modelpick
  `docs/decisions/podcast-writer.md` §2026-10-26. Harness: `scripts/writer-bakeoff.ts`, `scripts/writer-lab.ts`,
  `scripts/lib/bakeoff-{inputs,synth}.ts`; artifacts `data/writer-bakeoff/`, `data/writer-lab/` (gitignored).
- **Expressiveness is switched off in practice.** The last 6 long episodes contain **0** inline tags (2,346–7,180 words
  each); the bake-off Opus interaction draft had 1 `<short pause>`, the revision removed it. Causes:
  `src/podcast-script.ts` writer rule 6 (~601: "at most one tag every six turns … Most turns carry NO tag") plus the
  fact & speech editor's "flag over-use" (~764). Both hosts always get the constant style `"warm, conversational"`
  (`src/config.ts` ~486 `PODCAST_HOST_STYLE_A/B`), dense turns `DENSE_TURN_STYLE` (`src/podcast-synth.ts`).
- **Gemini 3.8 supports per-turn delivery:** `parts[].speechMetadata.style` per multi-speaker part, a short free-text
  string, English, never spoken; measured tempo/energy effect. Rules and traps: modelpick `docs/gemini-tts.md`
  §Style control (no persona blocks, no words from the transcript, no age/gender/accent, reuse exact strings; a
  `Style:` text prefix is SPOKEN). Allowed tags: `SPEECH_TAGS` in `src/gemini-tts-core.ts`; the doc's vocalisation
  table lists more that 3.8 accepts — only add a tag after an IU check that it is not spoken.
- **Context:** the bake-off source episode `8ee3a4df` ran with `research: false` → empty dossier, **no glossary**, so
  every writer had to introduce names blind. Research is ON by default; `--no-research` in `scripts/podcast.ts` turns
  it off. Episodes with research had 17–38 glossary terms.
- **Sonnet failure (Wave 1):** `claude-sonnet-5-5` returned `[A] …` screenplay text instead of the JSON object, twice
  (`data/writer-bakeoff/fail-claude-sonnet-5-5.json`). A format-robustness bug in the claude branch of
  `callPodcastLlm`, not a quality verdict.
- **IU availability, probed 2026-10-26** (chat completions, 200 = served): `gpt-6.1-sol` ✓, `gpt-6-sol` ✓ (older),
  `gpt-6-luna` ✓, `gemini-3.8-flash` ✓ (vertex EU), `gemini-3.1-pro-preview` ✓, `gemini-4-argon` ✓;
  `gemini-3.8-pro`, `gemini-3.8-flash-lite`, `gpt-6-terra` ✗. Claude on the native Anthropic route.
- **List prices / evidence (research 2026-10-26, verify any you put in `src/usage.ts` RATES):** Opus 5.5 $4/$20
  (cache read $0.20) · Sonnet 5.5 $2/$10 (cache read $0.10; community: verbose) · Haiku 5.5 $0.10/$0.50 ≤100k prompt ·
  gpt-6.1-sol $2/$10 (EQ-Bench CW v3 2125, slop 8.97 — best measured) · gpt-6-luna $0.10/$0.50 (concise, no creative
  evidence) · gemini-3.8-flash $0.75/$3.75 (CW 1745, slop 22.6 — sloppy) · gemini-3.1-pro $2/$12 · gemini-4-argon:
  price unknown (LMArena creative ~1519, near Opus 1516–1534) — find it. No German writing evidence exists for any.
- First bake-off cost/episode (projected, uncached): haiku $0.07, deepseek $0.11, gpt-6-sol $0.37, Opus $1.73.

## Wave 3 — Expression, context, rematch            <!-- status: done (partial rematch — see Left behind) -->
- [x] **Per-turn delivery.** Add an optional `delivery` to script turns, chosen from a small fixed English vocabulary
      in code (≈8–10 strings, e.g. curious, amused, surprised, serious, thoughtful/slower, energetic/faster, dry,
      warm — your call, each verified on IU as never spoken). Writer prompt: baseline = no delivery; set it where the
      moment changes. Synth: `style = turn.delivery ?? host baseline`; dense turns keep the slow style. ElevenLabs
      fallback lane ignores it. Revision/tightening must preserve it.
- [x] **Tag policy from evidence, not fear.** Replace the "one tag every six turns" rule with a band (e.g. per segment
      a few well-placed pauses and real reactions; laughs only where something is funny) and make the fact & speech
      editor flag MISUSE (placement, staging, invented tags), not mere presence. Pick the band from the listening test.
- [x] **Deterministic expression + segmentation lint** in `src/podcast-lint.ts`, fed to reviewers like the existing
      lint and recorded in the job profile: tag not in allowlist; tag as the first word of a short turn; adjacent
      tags; tags per segment below/above the band; delivery outside the vocabulary; same non-baseline delivery on 3+
      consecutive turns; delivery on a turn under N words; >1 CAPS emphasis per turn. Segmentation: every
      multi-speaker unit ≤ 3,000 chars, never across a segment, no unit that ends on a question whose answer opens
      the next unit (prefer cutting after an answer); report unit count and size spread. Tests for every rule.
- [x] **Listening proof for expression (cheap, synth only):** take one finished improved-pipeline script segment and
      voice it 3 ways — A as today (no tags, constant style), B tag band, C tag band + per-turn delivery. Blind on
      `/tts` as a new open question "Expressiveness".
- [x] **Context for the rematch:** regenerate the bake-off inputs with the production research stage ON (dossier with
      glossary, prior coverage) for episode `8ee3a4df`, then a fresh frozen outline from the current prompts. If
      something else in the writer's context is clearly missing for a stranger-listener (e.g. what earlier episodes
      already explained), add it only if cheap and measured — note it otherwise.
- [x] **Fix Sonnet's format failure** in the claude branch: research the current Anthropic way to force a JSON object
      (structured outputs / `output_config.format`, or a tool) with adaptive thinking on IU; fall back to one repair
      retry. Test with a recorded screenplay reply.
- [x] **Writer rematch, IU only**, full production per-segment flow INCLUDING tightening, Wave 2 + Wave 3 prompts,
      the research dossier, opening + interaction segments, voiced with the expressive synth: `claude-opus-5-5`
      (baseline, cached), `claude-sonnet-5-5`, `claude-haiku-5-5`, `gpt-6.1-sol`, `gpt-6-luna`, `gemini-4-argon`,
      `gemini-3.8-flash`, plus one **hybrid**: the best cheap drafter + Opus only for the revision pass. Record per
      candidate: cost/episode with caching (cache tokens from usage), words vs target, lint + expression-lint counts,
      wall time, failures. Blind on `/tts` as "Podcast writer — rematch" (old bake-off stays as reference).
- [x] modelpick `docs/decisions/podcast-writer.md`: dated rematch section with the table and a **ranked
      recommendation** (quality evidence, cost/episode); verdict pending the owner's ears. Record the expression
      findings in `docs/gemini-tts.md` if new facts were measured.
- [x] **(10) Research without the starvation budget (architecture, BEFORE the rematch).** Brain AND web, whatever it
      takes. OWNER CORRECTION: NO per-episode USD ceiling and no call cap by default (quality over cost; savings come
      from choosing an efficient model) — only identical-query dedupe and the existing hang/idle guards, tool description says web research is EXPECTED for anything the listener
      needs that notes/brain do not explain; research spend in the job profile.
- [x] **(11) Agentic writer (architecture, BEFORE the rematch).** The single-shot draft cannot measure its own text.
      Per-segment draft + revision become a tool loop on the existing `src/llm-tools.ts` `runToolLoop` (no new
      framework): `lint_segment` (lint + expression/segmentation, metrics: words vs target, turn lengths, questions,
      tags/delivery), `glossary_lookup` / `brain_search` / `brain_read`, `submit_segment` (validates JSON + lint, rejects
      with findings until clean or the model accepts remaining advisory findings with a reason). Claude: native
      Anthropic tool use in the loop (keep caching) or prove IU serves Claude tools on the OpenAI route — pick the
      cleaner. Reviewer panel stays after the loop. Measure one segment vs single-shot (lint, words/target, cost, wall);
      then the rematch runs with this writer for every candidate. Single-shot rematch partials (Opus, Haiku, Luna) kept
      in `data/wave3/singleshot/` as the "before" ($2.1 of the $4 cap spent there).
- [x] **(12) Learnings from job 503c28f0 ("Mit Schale, mit Erde", regression fixture `src/__fixtures__/episode-503c28f0.*`).**
      (a) meta-hedging: "steht nicht in deinen Notizen"/"das wissen wir nicht" ~9x — prompt rule 6b + lint
      `notes-ignorance` (blocking in the agent) and `meta-hedge` (>2 per episode); (b) the listener brief binds the editor's
      humor (`playfulAsk` raises "sparse" to "natural" + editor prompt); (c) turn ownership — prompt rule 6c, editor roles
      and lint `host-imbalance`. v2 regeneration of the same topic is the owner's, after deploy (source/brief stay in
      the job request and `/tmp/produce/source.md`).
- [x] **(8) Expression in every lane.** Delivery vocabulary + tag allowlist as one shared module in `gemini-tts-core`
      (podcast, briefing, chat use the same words). Briefing prep: per-chunk style from the vocabulary (stable baseline,
      deviations where the content turns) and a tag band instead of "sparse" (`PREP_STYLE` / `BRIEFING_TAGS` in
      `gemini-tts.ts`). Chat lane (flash-lite, prep off): no extra LLM call — allowlisted inline tags in the INPUT pass
      through, invalid ones are stripped, optional request `style` the caller can set (Hermes writes tags itself; the
      hermes-agent side is the owner's). Listening proof per lane inside the "Expressiveness" question on `/tts`
      (briefing: baseline vs expressive; chat: plain vs tagged), synth-only.
- [x] **(9) Research stage looks up external names.** The research-gateway tool is wired (max 2 calls) but was used once
      in ~10 episodes ("only for a fact the episode hinges on … sparingly"). The listener problem is unexplained
      third-party names (Cortex, engrams, DBOS): make the stage look up external names/projects/tools that neither
      source nor brain explains (batched into one query), feed the result into the glossary. Measure on `8ee3a4df`
      with research on: glossary size and first-mention names introduced. `PODCAST_RESEARCH_MAX_CALLS` stays bounded.
- [x] Ship proven code (delivery field, synth wiring, lint, prompt/tag policy, Sonnet fix) with tests, `/review`, gates;
      commit per concern; push; `make deploy` on the mini only when no podcast job runs; modelpick deployed + verified
      (`/tts` 200, every new audio file resolves). Report actual IU spend.
**Left behind:**
- **The rematch is partial** — the $4 IU cap (spent $3.73 + ~$0.1 research gateway) stopped it after the architecture work
  (agentic writer, research redesign, 503c28f0 fixes) and a first single-shot pass ($2.1, kept in `data/wave3/singleshot/`
  as the "before") consumed most of it. Measured on the final design: `claude-haiku-5-5` (agentic) and `gpt-6.1-sol`
  (single-shot — IU serves its function tools only on `/v1/responses`). Not run: `gpt-6-luna` (aborted mid-run by the
  cap), `gemini-4-argon`, `gemini-3.8-flash`, `claude-sonnet-5-5`, `claude-opus-5-5` agentic baseline, the hybrid —
  ~$4.5 more. Owner decision: raise the cap, or accept Sol vs Haiku as the blind pair.
- Follow-up: a `/v1/responses` transport in `runToolLoop` would put gpt-6.1-sol (the cost leader) on the agentic loop.
- Tag band not chosen from the owner's ears yet (lint band 1–3.5 per ten turns, prompt 'one every four to eight').
- Sample `Expressiveness` and `Podcast writer — rematch` questions are on `/tts`; the Opus baseline is missing from the latter.
- The modelpick `writer-rematch` experiment, decision record and `docs/gemini-tts.md` are committed and pushed; modelpick deploy is the modelpick tab's.

## Wave 4 — Finish the rematch, Sol on the loop, Audiobookshelf hygiene            <!-- status: done -->
**Owner, 2026-10-26: no spend ceiling — quality over cost.** The harness keeps a runaway stop only (IU $15 for this wave,
checked before every call); it is not a budget. A podcast job may be running — `make deploy` refuses then; wait, never kill.
- [x] **`/v1/responses` transport in `runToolLoop`** so `gpt-6.1-sol` (the cost leader) runs the agentic writer like
      everyone else (IU serves its function tools only there — Wave 3 finding). Research the current Responses API tool
      shape first; keep the chat-completions path unchanged; tests with recorded replies.
- [x] **Finish the rematch on the final design**: `claude-opus-5-5` agentic (the baseline — currently missing on `/tts`),
      `claude-sonnet-5-5`, `gpt-6.1-sol` agentic, `gpt-6-luna`, `gemini-4-argon`, `gemini-3.8-flash`, and the hybrid (best
      cheap drafter + Opus revision). Same frozen inputs as Wave 3. Voice, add to the blind "Podcast writer — rematch"
      question, update the modelpick decision record with the full table and a ranked recommendation. Writer default
      stays `claude-opus-5-5` until the owner's ears decide.
- [x] **A/B fixture:** compare job `503c28f0` (v1, old pipeline) and the v2 job of the same topic (the orchestrator starts
      it) on the Wave 3 lint metrics (meta-hedges, host balance, tags/delivery, humor) — a short table in the decision record.
- [x] **Audiobookshelf hygiene** (library "Podcasts", show "Brain Sonderausgabe", 13+ episodes; API via `ABS_URL` over
      https from `.env.mini.publish.tpl`). Finding: only 4 episodes are marked finished although the owner listened to
      many; superseded versions (e.g. "Factory v2" next to "Factory v2.2") and a 3-minute Gemini test episode are listed.
      (1) Find out from listening sessions (`/api/me/listening-sessions` or equivalent — research the ABS API) why progress
      does not stick (client, device, offline sync) and report. (2) Add a `podcast` CLI subcommand `abs-tidy` that lists
      finished/abandoned/superseded/test episodes and, with `--apply`, marks listened-through ones finished and removes
      superseded/test ones — dry run by default; deletion only with explicit `--apply`. Do NOT apply it in this wave; the
      owner reviews the dry-run output first. (3) When a new episode supersedes an older one on the same topic, the
      publish step can mark the old one (metadata note or finished) — propose, implement only if small.
- [x] Gates, `/review`, commit per concern, push, deploy when no job runs. Report spend.
**Left behind:**
- **Owner narrowed the rematch mid-wave:** `claude-opus-5-5` agentic, `gemini-4-argon` (measured, $1.23/ep, not in the blind question) and the Opus-revision hybrid are out as too expensive; the hybrid is behind `--hybrid` in `scripts/writer-rematch.ts` if wanted. Blind on `/tts`: Haiku B, Flash D, Sonnet E, Sol G, Luna J. Full table and ranking in modelpick `docs/decisions/podcast-writer.md`. Verdict is the owner's ears; the writer default stays `claude-opus-5-5`.
- **IU spend Wave 4: about $3.5** (ledger $7.34 total less the $3.85 carried in); runaway stop $15 never near. The v2 episode job `b78cb035` cost $4.90 on top (Opus default writer).
- **Flash** cannot hold the agentic loop inside IU's ~230 s non-streaming limit (single-shot fallback, 17 lint findings); **Luna** writes ~35% short and never sets a delivery — a length lever in the loop would be the follow-up if it wins the listen.
- **A/B `503c28f0` v1 vs v2** is in the decision record (meta-hedges 3→0, notes-ignorance 5→0, host A share 74%→30%, deliveries 0→12). v2 is 37% shorter than v1 — ears decide whether that is the target or lost content.
- **Audiobookshelf:** progress does not stick because `plappa` (iOS) re-opens a finished episode as a fresh session from 0 and its sync overwrites `isFinished` (Nordspanien, Kessel, Factory v2); 5 episodes have no session at all (never synced or never played). `podcast abs-tidy` (dry run; `--apply` marks listened-through finished and hard-deletes superseded + test) is **not applied** — the owner reviews the dry-run first. Open policy question from review: `--apply` deletes a superseded/test episode regardless of listening state. Superseded-marking at publish time: not implemented (abs-tidy covers it after the fact).
- Follow-ups (review, not blocking): widen `ChatMessage` to a union so the responses transport needs no casts; integration tests for `markFinished` / `removeEpisode` URLs and `runAbsTidy --apply` before the first real apply.

## Wave 5 — Episode structure: coverage, opening, length            <!-- status: active -->
Evidence: v1 `503c28f0` vs v2 `b78cb035` (same source `/tmp/produce/source.md` + brief; also copied to
`data/podcasts/503c28f0-0174-4cd4-87e9-b1b0601a8450/source-input.md`). v2 won on voice (0 meta-hedges, 10 tags, 12 deliveries,
humor) and lost on structure:
- [ ] **Coverage:** the listener asked about eating RAW carrots unwashed from the bag; v2 turned the carrot segment into carrot
      GREENS/pesto (from a brain shopping list) and dropped the soil/germs/BfR wash-and-peel verdict — the most actionable answer.
      Extract the concrete listener questions/habits from the brief once (editor stage, stored in the brief), make the outline
      map each to a segment, and check at the end (dramaturge + a deterministic check that each question id has a verdict turn).
      Brain context may enrich an answer, never replace the asked question.
- [ ] **Opening:** v2 starts cold on "Das Grün." The first one or two turns say what the episode answers (playful is fine, no
      number pile). Check it in the dramaturge review and the lint (first segment, first turns reference the brief question).
- [ ] **Length:** 636 s / 1,517 words for a 15-minute ask (v1 2,368 words). Find where it was cut (editor minutes, outline
      targets, agent submit, tightening) and fix the cause; flag >20% under target in the lint and job profile. Luna's ~35%
      short (Wave 4) is the same lever.
- [ ] Tests (use both jobs as fixtures), `/review`, gates, push, deploy when no job runs. Then regenerate the topic as **v3** on
      the mini with the same source + brief (`--publish`), check coverage/opening/length/voice against v1 and v2 with
      `ab-fixture`, and record the table in the decision record.
**Left behind:**
