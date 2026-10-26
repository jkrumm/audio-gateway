# Podcast writer bake-off — cheaper voice owner?
**Goal:** Johannes can listen, blind, to the same podcast segments written by each candidate voice-owner model
(everything else identical: outline, brief, dossier, show bible, reviewers, Gemini 3.8 voices) on modelpick
`/tts`, next to measured cost per 20-minute episode — and pick whether Opus stays the writer.
**Why:** `podcast-segment` on `claude-opus-5-5` cost $3.41 of the last Gemini test episode, while all audio cost
$0.10. Writing is now the dominant podcast cost. Owner wants natural, witty, non-monotonous German dialogue with
strong host interaction, and is curious whether Grok is wittier.
**Gate:** `make check` here; in modelpick `make check`, `make deploy`, `make verify`. Spend caps: IU **$4**,
OpenRouter **$0.50**. Never push or `make deploy` audio-gateway while a podcast job runs. **No production config
change** in this wave — the writer default stays `claude-opus-5-5` until the owner decides.

## Established — do not re-derive
- Pipeline: `src/podcast-script.ts` (`writePodcastScript`, `callPodcastLlm` — `claude-*` on the native
  Anthropic wire with adaptive thinking, others on OpenAI chat completions; `resolveReasoningEffort`). Roles in
  `src/config.ts`: outline/editorial/metadata `deepseek-v4.1-flash`, voice owner `PODCAST_WRITE_MODEL`
  `claude-opus-5-5`, reviewers `gemini-3.8-flash,deepseek-v4.1-flash`, synth `gemini-3.8-flash-tts`
  (Charon + Erinome, multi-speaker runs ≤3,000 chars, `src/podcast-synth.ts`). Show bible `docs/show-bible.md`.
- Source material: episode `8ee3a4df-445a-4e57-ae37-d151aea362a5` ("Factory v2.2", 20 min) — `data/podcasts/
  <id>/{brief,dossier,script}.json`, request in `data/podcasts.db` table `podcast_job.request_json`. The outline is
  NOT stored: generate it once with the production outline model and freeze it for every candidate.
- Candidates (IU unless noted; $/M out; evidence 2026-10-25 research — EQ-Bench Creative Writing v3 Elo, LMArena):
  `claude-opus-5-5` baseline ($20; LMArena creative #1, EQ 2051) · `claude-sonnet-5-5` ($10; LMArena #22) ·
  `claude-haiku-5-5` ($0.50; no evidence) · `gpt-6-sol` ($10; EQ 2125 #4) · `kimi-k3` ($15; EQ 2084, German arena
  #5) · `glm-5.3` ($4.40; EQ 2077, German #13) · `deepseek-v4.1-flash` ($1.20; German #17) · **`grok-4.7`** ($6;
  EQ 2012 but highest rubric 17.16) — NOT on IU: call OpenRouter `x-ai/grok-4.7`
  (`https://openrouter.ai/api/v1`, key `op://common/openrouter/API_KEY`, resolve with `secrets-run`; it is the
  email-gateway key with a $10/month cap, so this one-off test must stay ≤ $0.50). Keep the OpenRouter route
  script-local (an injected base URL/key for the bake-off), not a production code path.
- No German creative-writing evidence exists for any of them — the listening test is the evidence.

## Wave 1 — Write, voice, measure            <!-- status: done -->
- [x] `scripts/writer-bakeoff.ts`: load the episode's brief + dossier, generate + freeze one outline, then for each
      candidate run the **production** per-segment flow with the candidate as voice owner (draft → the production
      reviewer panel → the candidate's revision/tightening), for **2 segments**: the opening and the segment with
      the most host interaction. Reuse exported pipeline functions; if something must be exported, do it without
      behaviour change. Production reasoning settings per model family. Cache results to disk so a rerun skips done work
- [x] Per candidate record: words vs target, wall time, input/output tokens, cost (list price, source), retries /
      parse failures, tag-allowlist violations (`SPEECH_TAGS`), and a projected **writer cost per 20-minute episode**
      (scale by the episode's real segment count and the measured revisions)
- [x] Synthesize every candidate's 2 segments with the production Gemini multi-speaker path (identical settings)
- [x] modelpick: copy audio into `data/tts-compare/audio/`, add samples (new `set: "writer"`) to
      `data/tts-compare/manifest.json`, and a new open question "Podcast writer" in
      `src/server/audio/experiments.ts` — rows = segment (opening / interaction), columns = candidates, **blind by
      default** (letters only, reveal per card), the written script viewable per cell, and a compact cost/episode
      line revealed with the model name. It must feed the existing "Your picks" summary
- [x] modelpick `docs/decisions/podcast-writer.md`: refresh the stale header (it still names opus-4-6 and
      ElevenLabs) and add a dated bake-off section — table (model, $/M out, cost/episode, words vs target, wall time,
      violations) + per-candidate notes, verdict **pending the owner's blind listening**
- [x] Gates green, commit per concern in each repo, push, modelpick deployed + verified (`/tts` 200, every new audio
      file resolves). Report actual IU + OpenRouter spend
**Left behind:**
- `scripts/writer-bakeoff.ts` (+ exported pipeline internals, no behaviour change); artifacts in `data/writer-bakeoff/`
  (gitignored): `outline.json` (frozen), `run-<candidate>.json` (final + draft scripts, review notes, timings, tokens, cost),
  `usage.db` (the bake-off's own ledger), `letters.json` (blind letter → model; do not paste it into chat).
- 7 of 8 candidates voiced; `claude-sonnet-5-5` failed (draft returned `[A] …` screenplay, not JSON, twice) — no audio.
  Picks: opening = segment 0 "Die eine offene Entscheidung", interaction = segment 1 "Blog und Code".
- modelpick: blind "Podcast writer" question on `/tts` (deployed, `/tts` 200, all 14 writer mp3 resolve), decision doc
  refreshed with the 2026-10-26 section. Verdict **pending the owner's blind listening**; writer default unchanged.
- **Spend (list price): IU $4.53 vs $4 cap, OpenRouter $0.71 vs $0.50 cap — both exceeded.** The guard checked headroom
  before a candidate, not during (`kimi-k3` $1.85, `glm-5.3` $0.87, grok $0.71). Wave 2 must cap per call, not per candidate.
- Findings feeding Wave 2: Opus writer cost ≈ $1.7/episode projected; `glm-5.3`/`kimi-k3` need 15–25 min per two segments;
  `gpt-6-sol` is 29 s / ≈ $0.37; the reviewers' notes were large (44–56 per candidate) and every candidate was revised.

## Wave 2 — Learn and improve            <!-- status: done -->
**Owner request (two addenda).** The bake-off is not just a ranking: learn from it and improve the pipeline. **IU cap $3
(enforced per call, not per candidate)**; same no-deploy-during-job rule; writer MODEL default still waits for the owner's blind
listening. Keep what works: fast pace, concise, technical, interesting — do not trade density for chatter (item 7).
- [x] 1 Cost levers, same voice owner: Anthropic prompt caching (`cache_control` on the stable prefix — system prompt, show bible,
      dossier, outline — in the `claude-*` branch of `callPodcastLlm`/`anthropic-messages.ts`); measure the input-cost drop on one
      segment; check whether OpenAI-wire models cache automatically via IU (`prompt_tokens_details.cached_tokens`). Measure what each
      revision/tightening pass changes (diff size, notes resolved) and whether a pass can be dropped or made conditional.
      Facts: 2026-10-25 Opus `podcast-segment` = 24 calls, 388k input / 93k output tokens, $3.41, no `cache_control` anywhere.
- [x] 2 Learn from the scripts: read every candidate draft (`run-*.json`) against `docs/show-bible.md`; catalogue concrete failure
      patterns (AI-isms/stock phrases, lecture turns, monotone turn-taking, missing reactions/interruptions, weak hooks/endings,
      tag misuse) and what the strongest drafts did differently. Output: show-bible edits as short German before/after examples
      (not more rules), writer/reviewer prompt fixes, and a cheap deterministic script lint (turn-length variance, reaction/question
      ratio, banned phrases, monologue length, first-mention check — item 6) whose output is fed to the reviewers.
- [x] 3 Prove it: rewrite the interaction segment with the improved prompts on the current writer and the best-value candidate,
      voice them, add before/after samples to the `/tts` "Podcast writer" question.
- [x] 4 Ship what is proven (caching, lint, prompt/show-bible edits) with tests, review and the gates; record findings in modelpick
      `docs/decisions/podcast-writer.md`.
- [x] 5 Episodes all sound the same (a scripted disagreement). Owner wants knowledge SHARING to dominate (one host knows and
      explains, the other asks sharp questions, both add); disagreement only when the material is genuinely contested.
      Evidence: 5 of the last 8 briefs list a "live disagreement" device; format names repeat. Fix: reframe outline `tension`
      (`podcast-script.ts`) as the segment's pull (open question, curiosity, a reveal — not necessarily conflict); drop "a live
      disagreement" as a default hook option; make the editor (`podcast-editorial.ts`) choose the episode MODE from the material and
      vary it against recent episodes (explainer/walkthrough, story, Q&A where the curious host drives, debate only if contested);
      let the dramaturge flag a manufactured argument; show-bible "Einwand" line. Test on the bake-off material that the brief no
      longer defaults to a debate.
- [x] 6 Hosts talk about places, people, projects and tools as if the listener knew them (private notes leak shared context).
      Enforce: every proper name/place/project/internal term is introduced on first mention in one plain clause. The show-bible name
      rule exists but is not enforced: add it to the fact & speech editor review and to the deterministic lint (first-mention check).
- [x] 7 Guardrail on 5 and 6: pace, density and technical depth stay (measure words/turn and facts/minute before and after).
**Left behind:**
- Shipped (master, tests + review clean): prompt caching on Claude writer calls (`cacheablePrefix`, measured −52% input / −21% per call
  on the second segment call, ~$0.8–0.9 of the $3.41 episode if warm); `src/podcast-lint.ts` fed to reviewers (stock-phrase and
  unintroduced-term findings also become revision notes); outline `tension` reframed as the segment's pull; editor chooses a MODE
  and no longer defaults to a debate (3/3 replays: Explainer, Explainer, Q&A, no disagreement device); dramaturge flags manufactured
  arguments; writer + fact-editor name rule covers every name judged as a stranger; show-bible before/after pairs.
- Measured, NOT shipped: revision rewrites 40–70% of words from 17–30 notes/segment (inflated by the 2-segment bake-off); a note cap or
  conditional pass needs ears first. Moving the segment instruction tail out of the system prompt would make SOURCE + outline
  cacheable (~7k more tokens/call); changes prompt layout, needs listening.
- Proof: `/tts` "Podcast writer — improved pipeline" (Opus and gpt-6-sol, old vs new, blind). Opus lint 5 findings → 0, second host asks
  11 questions, 23 turns vs 9. Not proven: density (fact-coverage proxy 2/8 → 3/11) and length (731 words vs 590 target; the lab run
  skips the tightening pass). The writer MODEL default is unchanged and waits for the owner's blind listening.
- Spend: lab ledger $1.05 at list price (cap $3, enforced before every call); research $0.04. Wave 1's caps were exceeded (see above).
- Note for the owner: an episode produced on the mini only gets these changes after `make deploy` there (done at close-out if no job ran).
