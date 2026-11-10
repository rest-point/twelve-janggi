# Competitive Twelve-Janggi Model Design

Date: 2026-11-10

## Intent

Add a new team-authored model to the GitHub repository that can compete with the strongest models currently published on GitHub. Preserve all existing model artifacts and benchmark each opponent under reproducible conditions. A win is an empirical outcome, not a guarantee of universal superiority.

## Goals

- Work on a new branch based on the latest model-bearing upstream branch, `origin/temp`.
- Register a new immutable `js-v1` model under a fresh `team-*-v1` ID.
- Target `azero-v2`, `packed-gemm-puct-v2`, and `tablebase-minimax-reply-v2`; also include `lab-neural-v2` from the published `codex/winrate-lab` branch if it can be integrated without importing unrelated lab changes.
- Use the latest opponents' 360 ms search cap as the initial budget.
- Confirm legal responses, strict-v2 rules, time limits, and replay validity. Run a four-game smoke comparison against each target, then a 100-game balanced comparison for candidates that remain competitive.
- Report wins, draws, losses, score rate, average and p95 move time, model errors, seeds, run IDs, and limits.

## Non-goals

- Do not modify or replace the existing opponents, rules engine, UI, or saved match records.
- Do not claim a guaranteed win or general ranking from a small screening batch.
- Do not import every experimental file or benchmark artifact from the win-rate lab.

## Approaches

1. **Neural-guided PVS with exact endgame oracles and tactical proof search (recommended).** Reuse the trained AlphaZero policy/value weights to order moves and evaluate unresolved leaves; use the repository's PVS/alpha-beta search, exact full-tablebase answers where supported, and bounded DFPN for forced wins. This combines broad positional guidance with exact endgames and tactical proofs under a fixed time cap.
2. **Only tune the existing classical tablebase/PVS model.** Lowest implementation risk and strong exact endgames, but it leaves the learned move ordering/evaluation unused and likely has less guidance in the opening.
3. **Train another self-play model.** It could discover new play but needs substantial compute and held-out validation, and the published self-play models already have strong evaluation.

Default choice: approach 1 because it combines the best capabilities already available in the repository while leaving opponents unchanged. Keep its iteration budget and limits bounded; select final settings from actual games.

## Constraints and implementation calls

- Branch: `codex/competitive-model`, based on `origin/temp`; publish the branch after implementation and validation, consistent with the earlier request to work on GitHub.
- Preserve the current `codex/three-ai-models` branch and all immutable model IDs.
- Use strict ruleset `twelve-janggi-strict-v2`, named `think(request)`, and only declared model files. Do not add packages, external processes, or network access.
- Keep all search state, caches, and repetition counts local to one think request.
- Treat tablebase values as exact only for positions the tablebase supports; distinguish repetition-history cases that can change an outcome.
- Use the initial 360 ms cap and adjust only after comparing results. Retain safe fallback to a legal move if no search iteration completes.

## Evaluation

Use first-move games with balanced sides and starting turn, fixed seed, and the same per-move cap for candidate and rivals. First run four games per rival as a protocol/screening check. For any viable candidate, run 100 games against each current top rival, with 25 games per side/starting-turn combination. Replay-verify every completed game. Keep generated game data in ignored local artifacts; commit the report and code, not private state or databases. If the candidate does not score better than a target, inspect its losses and make a versioned follow-up instead of describing it as a winner.

## Open implementation choices

- Exact interaction between tablebase answers, AlphaZero leaf values, and DFPN results.
- Whether `lab-neural-v2` can be added as a benchmark-only registry entry with its minimal required files.
- Search constants selected within the 360 ms budget using the screen results.

