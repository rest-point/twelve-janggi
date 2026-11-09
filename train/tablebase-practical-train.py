"""Train a standalone ranker for safe draws, using several opponent styles."""

import argparse
import itertools
import json
from pathlib import Path
import subprocess

import numpy as np


ROOT = Path(__file__).resolve().parents[1]


def run_league(mode, **options):
    command = ['node', 'train/tablebase-practical-league.mjs', '--mode', mode]
    for key, value in options.items():
        command.extend((f'--{key}', str(value)))
    subprocess.run(command, cwd=ROOT, check=True)


def train_ranker(dataset, seed, epochs):
    rng = np.random.default_rng(seed)
    groups = dataset['rows']
    if len(groups) < 8:
        raise ValueError('At least eight training positions are required')
    count = len(dataset['features'])
    feature_rows = []
    better, worse, gaps = [], [], []
    for group in groups:
        offset = len(feature_rows)
        choices = group['choices']
        feature_rows.extend(choice['features'] for choice in choices)
        # Reward mean conversion and also performance against the hardest
        # opponent in this group. Actual azero-v2 moves are absent from the set.
        targets = [0.75 * np.mean(choice['wins']) + 0.25 * min(choice['wins']) for choice in choices]
        for a, b in itertools.combinations(range(len(choices)), 2):
            if targets[a] == targets[b]:
                continue
            high, low = (a, b) if targets[a] > targets[b] else (b, a)
            better.append(offset + high)
            worse.append(offset + low)
            gaps.append(targets[high] - targets[low])
    if not better:
        raise ValueError('No candidates differed in conversion. Increase --positions or --train-plies.')
    x = np.asarray(feature_rows, dtype=np.float64)
    if x.shape != (len(feature_rows), count) or not np.isfinite(x).all():
        raise ValueError('Invalid feature rows')
    mean, scale = x.mean(axis=0), np.maximum(x.std(axis=0), 0.05)
    x = (x - mean) / scale
    better, worse, gaps = np.asarray(better), np.asarray(worse), np.asarray(gaps)
    width = 32
    w = rng.normal(0, (2 / count) ** 0.5, (width, count))
    b = np.zeros(width)
    v = rng.normal(0, width ** -0.5, width)
    params = (w, b, v)
    m, s = ([np.zeros_like(p) for p in params] for _ in range(2))
    step = 0
    for epoch in range(epochs):
        order = rng.permutation(len(better))
        loss = 0.0
        for start in range(0, len(order), 256):
            idx = order[start:start + 256]
            hi, lo = x[better[idx]], x[worse[idx]]
            ph, pl = hi @ w.T + b, lo @ w.T + b
            hh, hl = np.maximum(0, ph), np.maximum(0, pl)
            delta = (hh - hl) @ v
            loss += float(np.sum(gaps[idx] * np.logaddexp(0, -delta)))
            gd = -gaps[idx] / (1 + np.exp(np.clip(delta, -60, 60))) / len(idx)
            gh = gd[:, None] * v * (ph > 0)
            gl = gd[:, None] * v * (pl > 0)
            grads = (gh.T @ hi - gl.T @ lo + 1e-4 * w, (gh - gl).sum(axis=0), (hh - hl).T @ gd + 1e-4 * v)
            step += 1
            for i, (param, grad) in enumerate(zip(params, grads, strict=True)):
                m[i] *= 0.9
                m[i] += 0.1 * grad
                s[i] *= 0.999
                s[i] += 0.001 * grad * grad
                param -= 0.002 * (m[i] / (1 - 0.9 ** step)) / (np.sqrt(s[i] / (1 - 0.999 ** step)) + 1e-8)
        if (epoch + 1) % 5 == 0 or epoch + 1 == epochs:
            print(f'epoch {epoch + 1}/{epochs}, ranking loss {loss / len(better):.5f}', flush=True)
    if not all(np.isfinite(param).all() for param in params):
        raise ValueError('Nonfinite checkpoint')
    return {'format': 'strict-v2-draw-ranker-v1', 'features': dataset['features'], 'mean': mean.tolist(),
            'scale': scale.tolist(), 'hidden': w.tolist(), 'bias': b.tolist(), 'output': v.tolist(),
            'trainingPairs': len(better), 'seed': seed}


def summarize(validation, seed):
    names = ('baseline', 'candidate')
    rows = validation['rows']
    def aggregate(games):
        result = {}
        for name in names:
            logs = [game[name] for game in games]
            values = [entry['outcome'] for entry in logs]
            times = [time for entry in logs for time in entry['times']]
            result[name] = {'wins': values.count(1), 'draws': values.count(0), 'losses': values.count(-1),
                            'cutoffs': sum(entry['cutoff'] for entry in logs), 'winRate': values.count(1) / len(values),
                            'p95Ms': float(np.quantile(times, 0.95)) if times else None}
        return result
    games = [game for row in rows for game in row['results']]
    blocks = np.array([np.mean([int(game['candidate']['outcome'] == 1) - int(game['baseline']['outcome'] == 1)
                               for game in row['results']]) for row in rows])
    rng = np.random.default_rng(seed)
    bootstrap = np.array([rng.choice(blocks, size=len(blocks)).mean() for _ in range(10000)])
    lower, upper = np.quantile(bootstrap, [0.025, 0.975])
    total = aggregate(games)
    training_opponents = {'greedy', 'stockjang', 'packed'}
    unseen = aggregate([game for game in games if game['opponent'] not in training_opponents])
    unseen_delta = unseen['candidate']['winRate'] - unseen['baseline']['winRate']
    return {'positions': len(rows), 'gamesPerVariant': len(games), 'total': total,
            'byOpponent': {name: aggregate([game for game in games if game['opponent'] == name])
                           for name in validation['opponents']},
            'winRateDelta': float(blocks.mean()), 'winRateDelta95': [float(lower), float(upper)],
            'unseenOpponentWinRateDelta': unseen_delta,
            'passed': bool(len(rows) >= 48 and lower > 0 and unseen_delta >= 0 and total['candidate']['losses'] == 0)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--positions', default=384, type=int)
    parser.add_argument('--validation-positions', default=64, type=int)
    parser.add_argument('--workers', default=4, type=int)
    parser.add_argument('--train-plies', default=24, type=int)
    parser.add_argument('--validation-plies', default=120, type=int)
    parser.add_argument('--epochs', default=30, type=int)
    parser.add_argument('--seed', default=273101, type=int)
    parser.add_argument('--dataset', type=Path, help='Reuse an existing collection instead of collecting again')
    args = parser.parse_args()
    if not (8 <= args.positions <= 50000 and 2 <= args.validation_positions <= 50000 and 1 <= args.workers <= 16
            and 1 <= args.train_plies <= 240 and 1 <= args.validation_plies <= 240
            and 1 <= args.epochs <= 1000 and 0 <= args.seed < 2 ** 32 - 1):
        parser.error('Invalid training options')
    out = (ROOT / args.out).resolve()
    if ROOT / 'artifacts' not in out.parents or out.exists():
        parser.error('--out must be a new directory under artifacts')
    out.mkdir(parents=True)
    dataset = (ROOT / args.dataset).resolve() if args.dataset else out / 'dataset.json'
    if not args.dataset:
        run_league('collect', out=dataset, positions=args.positions, workers=args.workers,
                   seed=args.seed, horizon=args.train_plies)
    checkpoint = out / 'weights.json'
    data = json.loads(dataset.read_text(encoding='utf-8'))
    checkpoint.write_text(json.dumps(train_ranker(data, args.seed, args.epochs), indent=2) + '\n', encoding='utf-8')
    validation = out / 'validation.json'
    run_league('validate', out=validation, dataset=dataset, checkpoint=checkpoint, positions=args.validation_positions,
               workers=args.workers, seed=args.seed + 1, horizon=args.validation_plies)
    report = summarize(json.loads(validation.read_text(encoding='utf-8')), args.seed + 1)
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
