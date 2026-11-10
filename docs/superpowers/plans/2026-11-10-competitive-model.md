# Competitive Twelve-Janggi Model Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add and publish a team model that exploits the strict-v2 tablebase and history-aware search to score better against the strongest GitHub models, with reproducible pairwise results.

**Architecture:** Start from origin/temp, which contains the current strict-v2 engines and full tablebase. The standard-material tablebase covers the complete piece inventory and reports the initial position as a draw; the new search treats tablebase outcomes as primary, corrects them for threefold-repetition history, and uses the AlphaZero v2 policy/value network plus bounded PVS/DFPN for ordering and fallback. No score is guaranteed against a model that maintains the tablebase draw.

**Tech Stack:** Node.js >=24.7, JavaScript ES modules, existing Node test runner and evaluate/replay-verify scripts. No new packages.

**Spec:** docs/superpowers/specs/2026-11-10-competitive-model-design.md

## Global Constraints

- Ruleset: twelve-janggi-strict-v2; model protocol: js-v1 with named think(request).
- Preserve all existing immutable IDs and source files; register the new model under fresh team-contender-v1.
- Initial model search cap: 360 ms, leaving at least 10 ms of request budget for return/worker overhead.
- Keep search state and caches local to one think request; preserve full repetition history and do not mutate request data.
- Declare every imported helper, weight file, and all eight full-tablebase shards in the registry manifest.
- Do not add dependencies, external processes, network access, UI code, engine-rule changes, or an absolute 256-ply assumption.
- Benchmark each opponent with its published configuration; record different compute caps.

## Review Focus

1. A third occurrence in prior history must score as an official draw before any history-free tablebase value is applied.
2. Unsupported/nonstandard material (tablebase probe 0) must use search fallback, never be mistaken for a draw.
3. Side 1, hand drops, promotion, and king safety must produce only referee-legal actions.
4. A deadline or node cutoff must return a legal completed-iteration move and must never report an incomplete proof as a win.
5. The restricted ModelProcess must load declared shards and weights under its 128 MiB Worker limit and answer both starting sides.

---

### Task 1: Create isolated branch and import the strongest published neural baseline

**Files:**
- Worktree: ../twelve-janggi-competitive on branch codex/competitive-model at origin/temp
- Create: models/lab-neural-search-v1.mjs
- Create: models/lab-neural-v2.mjs
- Modify: models/registry.json
- Test: tests/competitive-baselines.test.js
- Copy approved docs: docs/superpowers/specs/2026-11-10-competitive-model-design.md and docs/superpowers/plans/2026-11-10-competitive-model.md

**Interfaces:**
- Baseline is the published lab-neural-v2 entry and search helper from origin/codex/winrate-lab.
- Keep its source and original 2,000 ms configuration unchanged. Existing origin/temp assets azero-core.mjs and azero-v2.bin provide its other dependencies.

- [x] **Step 1: Create the isolated worktree from origin/temp**
  - Follow the using-git-worktrees workflow; verify branch codex/competitive-model starts at origin/temp.

- [x] **Step 2: Copy the approved design and plan into the new worktree**
  - Keep their paths under docs/superpowers/specs and docs/superpowers/plans.

- [x] **Step 3: Set up the supported Node runtime and install locked dependencies**
  - Set $teamNode to C:/Users/leepl/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe and verify it reports v24.22.1.
  - Keep a persistent PowerShell session for the implementation and run all later Node commands through $teamNode. Set $teamNpmCli to Join-Path (Split-Path (Get-Command npm.cmd).Source) node_modules/npm/bin/npm-cli.js, then run $teamNode $teamNpmCli ci --ignore-scripts. Confirm a clean install.

- [x] **Step 4: Write the failing baseline registration test**
  - Add competitive-baselines.test.js. Assert registry contains lab-neural-v2 with protocol js-v1, ruleset twelve-janggi-strict-v2, exact entry/helper file list, and original maxTimeMs 2000 config.
  - Assert a real ModelProcess returns legal actions for initialState(0) and initialState(1) without mutating requests.

- [x] **Step 5: Run the test and confirm it fails because the baseline is absent**

Run: $teamNode --test tests/competitive-baselines.test.js
Expected: FAIL because lab-neural-v2 is not registered on origin/temp.

- [x] **Step 6: Import the baseline files byte-for-byte and register its original manifest**
  - Copy models/lab-neural-search-v1.mjs and models/lab-neural-v2.mjs from origin/codex/winrate-lab.
  - Keep the published code, weights, author metadata, and 2,000 ms configuration unchanged.

- [x] **Step 7: Run the baseline test and confirm both sides load in ModelProcess**

Run: $teamNode --test tests/competitive-baselines.test.js
Expected: PASS; both responses are legal and request objects are unchanged.

- [x] **Step 8: Commit the reproducible benchmark baseline**

Run:
~~~powershell
git add models/registry.json models/lab-neural-search-v1.mjs models/lab-neural-v2.mjs tests/competitive-baselines.test.js docs/superpowers
git commit -m "feat: add neural benchmark baseline"
~~~
Expected: only the baseline, test, and approved docs are committed.

---

### Task 2: Implement tablebase classification and history-aware search

**Files:**
- Create: models/team-contender-search-v1.mjs
- Create: tests/team-contender.test.js
- Reference: models/full-tablebase-v2.mjs, models/pvs-aspiration-rules-v1.mjs, models/pvs-aspiration-v1.mjs, models/azero-core.mjs, models/dfpn-proof-v1.mjs

**Interfaces:**
- Export analyze(request, services) from team-contender-search-v1.mjs; return { action, info } in the existing js-v1 shape.
- services provides tablebase.probe(position), tablebase.probeKey(key), scorePolicyValue(position, legalMoveCodes, seenCount), proveWin(position, attacker, limits), and now().
- scorePolicyValue returns { value: finite number, priors: finite numbers aligned with legalMoveCodes }. A tablebase raw value of 1 is a draw, abs(raw) >= 256 is a win/loss for the side to move with distance abs(raw)-256, and raw 0 is unsupported. DFPN status is conclusive only when status is win.

- [x] **Step 1: Write failing tests for oracle values, coverage, and repetition precedence**
  - Test initialState(0) and initialState(1) classify as tablebase draws.
  - Test deterministic legal play including captures, hand drops, and promotion remains indexable by denseIndex.
  - Test known tablebase win/loss values map to the correct side-to-move result and preserve distance ordering.
  - Test a third occurrence is an official draw even where the history-free probe returns a win.
  - Test twice-seen prior keys prevent an uncertified tablebase win from being called certain.

- [x] **Step 2: Run the focused tests and confirm the missing search exports fail**

Run: $teamNode --test tests/team-contender.test.js
Expected: FAIL because analyze and tablebase-aware classification do not exist.

- [x] **Step 3: Implement the injected search API and exact-outcome handling**
  - Convert FastPosition keys and action codes consistently with the engine.
  - Apply actual winner/repetition checks before tablebase probes. Interpret 0 only as unsupported.
  - At every supported node, check engine terminal/repetition outcomes first, then score the exact tablebase outcome and distance for the side to move. Search tablebase-equivalent moves with PVS when history can turn a theoretical win/loss into a draw; use policy priors to order ties and value output only as a tie-breaker.
  - If a position is unsupported, use neural-guided PVS and bounded DFPN fallback. TT score keys must include the full repetition-count context, or skip caching for history-sensitive nodes. Treat DFPN as a forced win only when status is win.
  - Reserve at least 10 ms, retain the last completed search result, and fall back to the first legal request action if no iteration completes.

- [x] **Step 4: Add failing edge tests for fallback, budget, and both sides**
  - Test unsupported material invokes fallback and never returns a tablebase draw.
  - Test very small budgets return a legal action and do not expose partial-depth/proof results as completed.
  - Test side 1 with a hand drop, a promotion edge, and king-safety constraints against engine legality.
  - Test request board, hands, positions, and legalActions remain unchanged.

- [x] **Step 5: Run the focused search tests and confirm they pass**

Run: $teamNode --test tests/team-contender.test.js
Expected: PASS with oracle, coverage, repetition, budget, side, and nonmutation cases.

- [x] **Step 6: Commit the isolated search component**

Run:
~~~powershell
git add models/team-contender-search-v1.mjs tests/team-contender.test.js
git commit -m "feat: add history-aware tablebase search"
~~~
Expected: focused search tests pass and only the search component and tests are committed.

---

### Task 3: Register the model and verify production worker permissions

**Files:**
- Create: models/team-contender-v1.mjs
- Modify: models/registry.json
- Create: tests/team-contender-integration.test.js

**Interfaces:**
- Export named think(request) from team-contender-v1.mjs; call analyze(request, services) and return { action, info: { nodes, completedDepth, searchMs } }.
- Registry ID: team-contender-v1; name: Team Repetition-Aware Tablebase Search; version: 1.0.0; protocol: js-v1; ruleset: twelve-janggi-strict-v2.
- Initial config: maxDepth 32, maxNodes 160000, maxTimeMs 360, tablebaseMaxMs 32, quiescenceDepth 5, tableEntries 8192, rootProofNodes 1000, proofDepth 12; keep all search inside the 360 ms cap.
- Manifest files include team-contender-search-v1.mjs, azero-core.mjs, azero-v2.bin, full-tablebase-v2.mjs, pvs-aspiration-rules-v1.mjs, pvs-aspiration-v1.mjs, dfpn-proof-v1.mjs, and strict-v2-0.tjb through strict-v2-7.tjb.

- [x] **Step 1: Write failing registry and ModelProcess tests**
  - Assert ID uniqueness, all imported assets are declared, all eight shards exist, and previous registry entries are unchanged.
  - Run a real ModelProcess for both starters, repeat a request to check Worker reuse, and assert responses are legal, stats are finite, requests are unchanged, and the worker stays inside its integration-test ceiling.

- [x] **Step 2: Run integration tests and confirm they fail because the model is missing**

Run: $teamNode --test tests/team-contender-integration.test.js
Expected: FAIL because team-contender-v1 is not registered.

- [x] **Step 3: Implement the model entry and registry manifest**
  - Load the AlphaZero v2 weights and open the tablebase once per Worker.
  - Keep dependencies inside models/ and list them, including all tablebase shards. Set the search deadline below budgetMs with a return reserve.

- [x] **Step 4: Run focused tests in the production Worker boundary**

Run: $teamNode --test tests/team-contender.test.js tests/team-contender-integration.test.js tests/full-tablebase-model.test.js tests/competitive-baselines.test.js
Expected: PASS; no worker permission denial, protocol error, illegal move, timeout, or request mutation.

- [x] **Step 5: Build the application and run the complete test suite**

Run: $teamNode scripts/build.mjs
Expected: build succeeds.

Run: $teamNode --test tests/*.test.js
Expected: all tests pass; any unrelated existing failure is reported by exact test name.

- [x] **Step 6: Commit the registered model after all checks pass**

Run:
~~~powershell
git add models/team-contender-v1.mjs models/registry.json tests/team-contender-integration.test.js
git commit -m "feat: register repetition-aware tablebase model"
~~~
Expected: only this model entry, registry line, and integration test are committed.

---

### Task 4: Tune and benchmark against the GitHub opponents, then report and publish

**Files:**
- Create: models/TEAM_COMPETITIVE_MODEL.md
- Create locally, ignored: artifacts/<run-id>/ from evaluate and replay verification
- Git branch: codex/competitive-model

**Interfaces:**
- Use existing scripts/evaluate.mjs and scripts/verify-replays.mjs; no new evaluator or database.
- Target IDs: azero-v2, packed-gemm-puct-v2, tablebase-minimax-reply-v2, lab-neural-v2.
- First-move batches use opening-plies 0, concurrency 2, move-ms 60000, max-plies 256, fixed seed 20261110. Keep the 360 ms cap on contender-v1 and retain each opponent's published config.

- [ ] **Step 1: Run a four-game screening batch against each target**

For each target, run:

~~~powershell
$teamNode scripts/evaluate.mjs --a team-contender-v1 --b <target-id> --games 4 --concurrency 2 --opening-plies 0 --move-ms 60000 --max-plies 256 --seed 20261110
$teamNode scripts/verify-replays.mjs --run artifacts/<run-id>
~~~

Expected: all games finish, no model errors, both sides/starting turns are represented, and each run passes replay verification.

- [ ] **Step 2: Review screening results and version any tuning**
  - Four games check protocol and expose obvious failures; they are not sufficient to claim strength.
  - Never overwrite an artifact already run or registered in a local database.
  - Keep 360 ms when it preserves score. If contender-v1 trails lab-neural-v2 at its published 2,000 ms configuration, create team-contender-v2 with maxTimeMs 2000 rather than silently changing v1.

- [ ] **Step 3: Run 100-game balanced batches against all four targets**
  - Use 25 games in each side/starting-turn combination, no opening plies, and retain opponents' published configs.
  - If team-contender-v2 is created, run its separate 100-game batch against lab-neural-v2 at the published 2,000 ms config and state the different compute budgets.

- [ ] **Step 4: Replay-verify every completed run and calculate results**
  - Record win/draw/loss, win rate, score rate (W + D/2), mean/p95/max move time, errors, seed, artifact/config hashes, and run IDs.
  - Treat repeated deterministic start conditions as a balanced matchup sample, not 100 independent positions.
  - tablebase-minimax-reply-v2 has an initial theoretical draw; do not claim it can be forced to lose. Report whether this candidate wins against its actual tie-breaking or preserves the draw.

- [ ] **Step 5: Write models/TEAM_COMPETITIVE_MODEL.md**
  - Explain the exact-tablebase and repetition-aware behavior, search budget, opponent configs, measured results, and limits.
  - State for each target whether score rate is above, equal to, or below 50%, and distinguish game wins from score rate.

- [ ] **Step 6: Re-run whitespace and focused tests**

Run: git diff --check
Expected: no whitespace errors.

Run: $teamNode --test tests/team-contender.test.js tests/team-contender-integration.test.js tests/competitive-baselines.test.js
Expected: PASS.

- [ ] **Step 7: Request a fresh whole-branch code review; fix important findings and rerun affected checks**
  - Verify final diff and test evidence before publishing.

- [ ] **Step 8: Commit and push the completed branch**

Run:
~~~powershell
git add models/TEAM_COMPETITIVE_MODEL.md
git commit -m "docs: record competitive model results"
git status --short
git log -1 --oneline
git push -u origin codex/competitive-model
~~~
Expected: report committed, clean branch, commit based on origin/temp, and matching local/remote branch heads. Push only after review and verification pass.




