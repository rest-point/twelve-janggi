#!/usr/bin/env bash
# Official CLI evaluation of one model against the whole league (web conditions:
# no opening plies, 256-ply cap, 60 s per move).
# Usage: train/tbrl-eval.sh <model-id> <games-per-opponent> <concurrency> <log-dir> [opponents...]
set -u
MODEL=$1; GAMES=$2; CONC=$3; LOG=$4; shift 4
OPPONENTS=${*:-packed-gemm-puct-v2 azero-v2 azero-v1 stockjang-v1 team-mcts-v1 team-minimax-v1 team-greedy-v1 minimax-v1 greedy-v1 random-v1 tablebase-minimax-reply-v2}
mkdir -p "$LOG"
for OPP in $OPPONENTS; do
  node bench/run.mjs --a "$MODEL" --b "$OPP" --games "$GAMES" --concurrency "$CONC" --opening-plies 0 > "$LOG/$MODEL--$OPP.log" 2>&1
  echo "$OPP: $(grep 'W/D/L' "$LOG/$MODEL--$OPP.log") $(grep '^Output:' "$LOG/$MODEL--$OPP.log")"
done
