"""Fit a standalone opponent-reply MLP from grouped legal moves."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn


def examples(positions):
    groups = []
    for item in positions:
        x = np.asarray(item['rows'], dtype=np.float32)
        validation = int.from_bytes(hashlib.sha256(item['board'].encode()).digest()[:4], 'little') % 5 == 0
        for style, counts in item['choices'].items():
            # A deterministic repeat adds no evidence. Keep variation but
            # discount heavily repeated replies to the same board.
            target = np.sqrt(np.asarray(counts, dtype=np.float32))
            groups.append((x, target / target.sum(), style, validation))
    return groups


def tensors(groups):
    count = max(len(x) for x, *_ in groups)
    inputs = np.zeros((len(groups), count, groups[0][0].shape[1]), dtype=np.float32)
    targets = np.zeros((len(groups), count), dtype=np.float32)
    mask = np.zeros(targets.shape, dtype=bool)
    styles = {style for _, _, style, _ in groups}
    totals = {style: sum(group[2] == style for group in groups) for style in styles}
    importance = np.array([1 / totals[style] for _, _, style, _ in groups], dtype=np.float32)
    for i, (x, y, _, _) in enumerate(groups):
        inputs[i, :len(x)], targets[i, :len(x)], mask[i, :len(x)] = x, y, True
    return tuple(torch.from_numpy(data) for data in (inputs, targets, mask, importance / importance.mean()))


def train(dataset, output, seed):
    torch.manual_seed(seed)
    torch.set_num_threads(2)
    groups = examples(json.loads(dataset.read_text(encoding='utf-8')))
    x, y, mask, weights = tensors([group for group in groups if not group[3]])
    vx, vy, vm, vw = tensors([group for group in groups if group[3]])
    model = nn.Sequential(nn.Linear(x.shape[-1], 64), nn.ReLU(), nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, 1))
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.002, weight_decay=0.01)
    mirror = torch.arange(x.shape[-1])
    mirror[:120] = mirror[:120].reshape(3, 4, 10).flip(0).flatten()

    def loss(a, b, legal, weight):
        scores = model(a).squeeze(-1).masked_fill(~legal, -1e6)
        return (-(scores.log_softmax(dim=1) * b).sum(dim=1) * weight).mean()

    best, checkpoint = float('inf'), None
    for epoch in range(40):
        for i in torch.randperm(len(x)).split(96):
            rows = x[i] if torch.rand(()) < 0.5 else x[i][:, :, mirror]
            optimizer.zero_grad()
            loss(rows, y[i], mask[i], weights[i]).backward()
            optimizer.step()
        with torch.no_grad():
            valid = (loss(vx, vy, vm, vw) + loss(vx[:, :, mirror], vy, vm, vw)).item() / 2
            if valid < best:
                best = valid
                checkpoint = torch.cat([p.detach().flatten() for p in model.parameters()]).numpy().astype('<f4')
    uniform = (vm.sum(1).float().log() * vw).mean().item()
    if checkpoint is None or not np.isfinite(checkpoint).all() or best >= uniform:
        raise ValueError(f'Validation loss {best:.4f} did not beat uniform {uniform:.4f}')
    output.write_bytes(checkpoint.tobytes())
    print(json.dumps({'trainGroups': len(x), 'validationGroups': len(vx), 'policyLoss': best, 'uniformLoss': uniform}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('dataset', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--seed', type=int, default=20261113)
    args = parser.parse_args()
    train(args.dataset, args.output, args.seed)
