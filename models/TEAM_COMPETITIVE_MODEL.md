# 장군: JANGGUN

`team-contender-v2` is the one new model retained on branch `codex/competitive-model`. It is a candidate for Twelve-Janggi strict v2; these results do not establish that it is universally stronger.

## How it chooses moves

- It probes the complete strict-v2 tablebase first. Exact wins and losses include distance-to-outcome, while exact draws score as draws.
- It checks the request's repetition history before accepting a history-free tablebase result. A prior third occurrence is an official draw, and a result whose certainty can be changed by repetition is searched further.
- It uses the AlphaZero v2 policy/value network to order candidate moves and evaluate unsupported positions. The search uses iterative deepening, principal-variation search (PVS), alpha-beta pruning, quiescence, and a transposition table keyed with repetition context.
- Bounded DFPN proof search can return a forced win only after a conclusive win result. A timeout or unknown proof never counts as a win.

The registry sets `maxTimeMs` and `tablebaseMaxMs` to 2,000 ms, `maxNodes` to 160,000, `maxDepth` to 32, and includes the eight tablebase shards and all worker dependencies. The actual think budget can shorten the search.

## Results

The four-game screens used seed `20261110`, no opening moves, and alternating sides/first turn. They are smoke screens, not reliable strength estimates.

| Opponent | W/D/L for contender | Score rate | Games |
|---|---:|---:|---:|
| `tablebase-minimax-reply-v2` | 0/4/0 | 50% | 4 |
| `azero-v2` | 2/2/0 | 75% | 4 |
| `packed-gemm-puct-v2` | 4/0/0 | 100% | 4 |
| `lab-neural-v2` | 1/3/0 | 62.5% | 4 |

Two balanced 100-game batches completed and passed replay verification. Each used seed `20261110`, concurrency 2, no opening moves, a 60,000 ms referee move limit, 256 maximum plies, and 25 games per side/starting-turn combination.

| Opponent | W/D/L for contender | Score rate | Mean / p95 / max move time |
|---|---:|---:|---:|
| `azero-v2` | 50/50/0 | 75% | 160.58 / 1,902.92 / 1,992.14 ms |
| `packed-gemm-puct-v2` | 56/44/0 | 78% | 563.45 / 1,911.66 / 1,996.73 ms |

The contender had a 2,000 ms model cap in these batches. The opponents used their registered configurations: AlphaZero's 800 simulations and Packed PUCT's 360 ms cap. These are not equal-compute comparisons. Move-time means are across accepted contender moves (2,050 vs AlphaZero and 1,125 vs Packed PUCT); p95 and max are from the same accepted-move timing records. No model failures were recorded in the completed runs.

All games began from the same initial position, so each 100-game result is a balanced repeated-start sample, not 100 independent positions.

The initial position is tablebase-drawn, so a perfect tablebase opponent can hold a draw. The 4-game screen against it ended 0/4/0. The planned 100-game batches against `tablebase-minimax-reply-v2` and `lab-neural-v2` were stopped before completion after the requested scope narrowed to one model; their partial games are excluded and were not replay-verified. Do not read the completed matchup scores as guarantees against other opponents or positions.

### Reproducibility references

| Batch | Run ID | Config hash |
|---|---|---|
| 4 vs tablebase | `2026-11-10T16-12-44-252Z-7cb912a6` | `dd8ddb5c877c818e69f6128c098738953c6b6171685dfef9424ff839cfc1f787` |
| 4 vs AlphaZero | `2026-11-10T16-13-33-494Z-599c567c` | `0aeca1946fe13df8432eaae636a9d0fda2984abcb9caed26ef45053af5522618` |
| 4 vs Packed PUCT | `2026-11-10T16-14-06-497Z-183a439b` | `f8e5ad964bcddda985380be7ab1aa6af4d159b6a505178a512785bc6e94e00bb` |
| 4 vs lab neural | `2026-11-10T16-14-46-838Z-50fa765f` | `8c103a7ca1c1ea8080b62dd06182e6998512a09bc25cd1309644097b71844c48` |
| 100 vs AlphaZero | `2026-11-10T16-26-06-787Z-0721b2c4` | `3ed005dfc0fc871e41a9c758d451983990514312c971496744da770edbad811f` |
| 100 vs Packed PUCT | `2026-11-10T16-26-06-821Z-d7a5be5a` | `e4bf0cc10f912bfd4f140dc15cfc58822658a6adaeabf98405a757e1e09a2d8a` |

The v2 entry digest is `9bbc5daa5786a840e9ed21d72b8172a857d844cd34f73a04506df7f47fca529a`; the search helper digest is `02bf3eaea3245514927761882e4a1523d545f32b9bbd353a1346df00be6f4398`.
