"""Tune Packed policy/value heads with paired games against azero-v2."""

import argparse
from array import array
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
MODEL = 'packed-gemm-puct-v2'
WEIGHTS = ROOT / 'models' / f'{MODEL}.bin'
POINTS = {'wins': 1, 'draws': 0.5, 'losses': 0}


def variants(base, layout, seed, step_scale=1):
    yield 'baseline', base
    randomizer = random.Random(seed)
    output_ranges = ((layout['p'], layout['v1']), (layout['v2'], layout['size']))
    noise = []
    for start, end in output_ranges:
        rms = (sum(value * value for value in base[start:end]) / (end - start)) ** 0.5
        noise.extend((i, randomizer.gauss(0, step_scale * 0.03 * rms)) for i in range(start, end))
    for label, sign in (('minus', -1), ('plus', 1)):
        candidate = array('f', base)
        for i in range(layout['p'], layout['v1']):
            candidate[i] *= 1 + sign * step_scale * 0.1
        yield f'policy-scale-{label}', candidate

        candidate = array('f', base)
        candidate[layout['vb2']] += sign * step_scale * 0.08
        yield f'value-bias-{label}', candidate

        candidate = array('f', base)
        for i, delta in noise:
            candidate[i] += sign * delta
        yield f'head-noise-{label}', candidate


def evaluate(args, config, weights, destination, *, screen, seed, tablebase=None):
    options = {
        'mode': 'eval', 'start': weights, 'out': destination,
        'games': args.screen_games if screen else args.validation_games,
        'workers': args.workers, 'seed': seed,
        'opening': 6 if screen else 10,
        'sims': args.screen_sims if screen else config['simulations'],
        'time-ms': args.screen_ms if screen else config['maxTimeMs'],
        'batch-size': config['batchSize'], 'proof-nodes': config['rootProofNodes'],
        'leaf-proof': config['leafProofNodes'], 'reply-proof': config['replyProofNodes'],
        'coverage': config['rootCoverage'], 'c-root': config['cInitRoot'],
        'root-value-penalty': config['rootValuePenalty'],
    }
    if tablebase:
        options['tablebase'] = tablebase
    command = ['node', 'train/packed-league.mjs']
    for key, value in options.items():
        command.extend((f'--{key}', str(value)))
    subprocess.run(command, cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    result = json.loads((destination / 'summary.json').read_text(encoding='utf-8'))
    summary = {key: result[key] for key in ('wins', 'draws', 'losses', 'scoreRate', 'p50Ms', 'inputHash')}
    if tablebase:
        summary['tablebase'] = result['tablebase']
        if summary['tablebase']['hash'] != args.tablebase_hash:
            raise ValueError('Tablebase changed during the sweep')
    print(destination.name, json.dumps(summary), flush=True)
    return summary


def games(directory):
    with (directory / 'games.jsonl').open(encoding='utf-8') as file:
        return [json.loads(line) for line in file]


def compare(baseline, candidate, excluded, seed):
    clusters = {}
    counts = [{outcome: 0 for outcome in POINTS} for _ in range(2)]
    for a, b in zip(games(baseline), games(candidate), strict=True):
        if (a['index'], a['opening']) != (b['index'], b['opening']):
            raise ValueError('Mismatched validation schedule')
        opening = a['opening']
        if opening in excluded:
            continue
        for totals, game in zip(counts, (a, b), strict=True):
            totals[game['outcome']] += 1
        win_delta = int(b['outcome'] == 'wins') - int(a['outcome'] == 'wins')
        score_delta = POINTS[b['outcome']] - POINTS[a['outcome']]
        clusters.setdefault(opening, []).append((win_delta, score_delta))
    blocks = [(sum(w for w, _ in rows), sum(s for _, s in rows), len(rows)) for rows in clusters.values()]
    if len(blocks) < 2 or any(n % 2 for _, _, n in blocks):
        raise ValueError('Validation needs at least two complete opening pairs')
    rng = random.Random(seed)
    samples = [[], []]
    for _ in range(10000):
        wins, score, count = map(sum, zip(*rng.choices(blocks, k=len(blocks))))
        samples[0].append(wins / count)
        samples[1].append(score / count)
    intervals = [(sorted(values)[249], sorted(values)[9749]) for values in samples]
    wins, score, count = map(sum, zip(*blocks))
    return {'games': count, 'openings': len(blocks), 'baseline': counts[0], 'candidate': counts[1],
            'winRateDelta': wins / count, 'scoreRateDelta': score / count,
            'winRateDelta95': intervals[0], 'scoreRateDelta95': intervals[1]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True, help='New directory under artifacts')
    parser.add_argument('--start', type=Path, default=WEIGHTS, help='Checkpoint to refine')
    parser.add_argument('--step-scale', type=float, default=1, help='Multiply all perturbation sizes')
    parser.add_argument('--rounds', type=int, default=1, help='Refine the round winner at successively smaller steps')
    table_options = parser.add_mutually_exclusive_group()
    table_options.add_argument('--build-tablebase', action='store_true', help='Build a tablebase before evaluating weights')
    table_options.add_argument('--tablebase', type=Path, help='Reuse a tablebase built by this project')
    parser.add_argument('--tablebase-positions', type=int, default=250000)
    parser.add_argument('--seed', type=int, default=271901)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--screen-games', type=int, default=48)
    parser.add_argument('--screen-sims', type=int)
    parser.add_argument('--screen-ms', type=int)
    parser.add_argument('--validation-games', type=int, default=192)
    args = parser.parse_args()
    out = (ROOT / args.out).resolve()
    if ARTIFACTS not in out.parents or out.exists():
        parser.error('--out must be a new directory under artifacts')
    if any(not 4 <= n <= 50000 or n % 4 for n in (args.screen_games, args.validation_games)):
        parser.error('Game counts must be multiples of four from 4 to 50000')
    if not 1 <= args.rounds <= 16 or not 0 <= args.seed <= 2**32 - 1 - args.rounds:
        parser.error('Use 1 to 16 rounds and leave room for their uint32 seeds')
    if not 0 < args.step_scale <= 5:
        parser.error('--step-scale must be in (0, 5]')
    if not 1 <= args.workers <= 32 or not 10 <= args.tablebase_positions <= 5000000:
        parser.error('Invalid worker count or tablebase position limit')
    if args.screen_sims is not None and not 1 <= args.screen_sims <= 10000:
        parser.error('--screen-sims must be in [1, 10000]')
    if args.screen_ms is not None and not 1 <= args.screen_ms <= 55000:
        parser.error('--screen-ms must be in [1, 55000]')
    if sys.byteorder != 'little' or array('f').itemsize != 4:
        parser.error('Float32 little-endian storage is required')
    layout = json.loads(subprocess.check_output([
        'node', '--input-type=module', '-e',
        "import { LAYOUT } from './models/azero-core.mjs'; console.log(JSON.stringify(LAYOUT))",
    ], cwd=ROOT))
    base = array('f')
    base.frombytes((ROOT / args.start).read_bytes())
    if len(base) != layout['size']:
        raise ValueError('Wrong checkpoint size')
    registry = json.loads((ROOT / 'models' / 'registry.json').read_text(encoding='utf-8'))
    config = next(entry['config'] for entry in registry if entry['id'] == MODEL)
    tablebase = out / 'tablebase.bin' if args.build_tablebase or args.tablebase else None
    if args.screen_sims is None:
        args.screen_sims = config['simulations'] if tablebase else 1200
    if args.screen_ms is None:
        args.screen_ms = config['maxTimeMs'] if tablebase else 150
    table_metadata = None
    out.mkdir(parents=True)
    if args.build_tablebase:
        print('Building tablebase', flush=True)
        table_metadata = json.loads(subprocess.check_output([
            'node', 'train/build-packed-tablebase.mjs', '--out', str(tablebase),
            '--max-positions', str(args.tablebase_positions), '--seed', str(args.seed ^ 0x9E3779B9),
        ], cwd=ROOT))
        print(json.dumps(table_metadata), flush=True)
    elif args.tablebase:
        tablebase.write_bytes((ROOT / args.tablebase).read_bytes())
    if tablebase:
        args.tablebase_hash = hashlib.sha256(tablebase.read_bytes()).hexdigest()
        if table_metadata and table_metadata['sha256'] != args.tablebase_hash:
            raise ValueError('Generated tablebase hash mismatch')

    starting = out / 'starting.bin'
    starting_bytes = base.tobytes()
    starting.write_bytes(starting_bytes)
    excluded = set()
    rounds = []
    for index in range(args.rounds):
        directory = out / f'round-{index + 1}'
        directory.mkdir()
        scale = args.step_scale * 0.5 ** index
        seed = args.seed + index
        results = {}
        for label, candidate in variants(base, layout, seed, scale):
            checkpoint = directory / f'{label}.bin'
            checkpoint.write_bytes(candidate.tobytes())
            results[label] = evaluate(args, config, checkpoint, directory / f'screen-{label}',
                                      screen=True, seed=seed, tablebase=tablebase)
        best = max(results, key=lambda label: (results[label]['wins'], results[label]['scoreRate']))
        base = array('f')
        base.frombytes((directory / f'{best}.bin').read_bytes())
        excluded.update(game['opening'] for game in games(directory / 'screen-baseline'))
        rounds.append({'seed': seed, 'stepScale': scale, 'screen': results, 'selected': best})

    selected = out / 'best-screen.bin'
    selected_bytes = base.tobytes()
    selected.write_bytes(selected_bytes)
    report = {'rounds': rounds, 'selected': selected.name}
    validation_seed = args.seed + args.rounds
    control = out / 'validation-baseline'
    changed = selected_bytes != starting_bytes
    if tablebase or changed:
        report['validationBaseline'] = evaluate(args, config, starting, control, screen=False,
                                                seed=validation_seed, tablebase=tablebase)
    if tablebase:
        no_table = out / 'validation-no-tablebase'
        report['tablebase'] = {'sha256': args.tablebase_hash, 'build': table_metadata}
        report['validationNoTablebase'] = evaluate(args, config, starting, no_table, screen=False,
                                                   seed=validation_seed)
        report['tablebaseEffect'] = compare(no_table, control, excluded, validation_seed)
    if changed:
        treatment = out / 'validation-candidate'
        report['validationCandidate'] = evaluate(args, config, selected, treatment, screen=False,
                                                 seed=validation_seed, tablebase=tablebase)
        report['pairedValidation'] = compare(control, treatment, excluded, validation_seed)
    (out / 'sweep.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f"Screen winner: {selected}. Validation results: {out / 'sweep.json'}", flush=True)


if __name__ == '__main__':
    main()
