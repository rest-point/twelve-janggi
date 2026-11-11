"""Train the tbrl value network on league data (GPU).

Rows come from train/tbrl-league.mjs: [features..., won, blunderNext, opponent, ply].
The network predicts P(we eventually win | position after our move), with an
auxiliary head for "the opponent's very next move is a proven blunder".
Only the main head is exported, in the Float32 layout of models/tbrl-core.mjs
(per layer: weight [out][in] row-major, then bias).

Usage: python train/tbrl-train.py --data a.bin b.bin --out models/tbrl-v1.bin --hidden 128,64
"""
import argparse, json, struct
import numpy as np
import torch
import torch.nn as nn

FEATURES = 134
COLUMNS = FEATURES + 4
TRAP = 8

p = argparse.ArgumentParser()
p.add_argument('--data', nargs='+', required=True)
p.add_argument('--decay', type=float, default=1.0, help='weight multiplier per older file (last file = 1)')
p.add_argument('--out', required=True)
p.add_argument('--hidden', default='128,64')
p.add_argument('--epochs', type=int, default=40)
p.add_argument('--batch', type=int, default=4096)
p.add_argument('--lr', type=float, default=2e-3)
p.add_argument('--aux', type=float, default=0.5)
p.add_argument('--seed', type=int, default=0)
p.add_argument('--trap', action='store_true', help='append <data>.trap.bin features (8 per row)')
args = p.parse_args()
INPUTS = FEATURES + (TRAP if args.trap else 0)
torch.manual_seed(args.seed); np.random.seed(args.seed)

chunks, weights = [], []
for i, path in enumerate(args.data):
    a = np.fromfile(path, dtype=np.float32).reshape(-1, COLUMNS)
    if args.trap:
        t = np.fromfile(path + '.trap.bin', dtype=np.float32).reshape(len(a), TRAP)
        a = np.concatenate([a[:, :FEATURES], t, a[:, FEATURES:]], axis=1)
    fw = np.full(len(a), args.decay ** (len(args.data) - 1 - i), dtype=np.float32)
    # Off-policy correction: the final outcome only measures a decision when
    # every later decision of the same game followed the greedy policy.
    # Games are contiguous; a new game starts when the ply fraction drops.
    meta = a[:, INPUTS + 2]; ply = a[:, INPUTS + 3]
    explored = meta >= 64
    a[:, INPUTS + 2] = meta % 64
    later_explored = False
    for r in range(len(a) - 1, -1, -1):
        if r + 1 < len(a) and ply[r + 1] <= ply[r]:
            later_explored = False  # row r is the last decision of its game
        if later_explored:
            fw[r] = 0
        later_explored = later_explored or explored[r]
    if explored.any():
        print(f'{path}: {explored.sum()} exploratory rows, {int((fw == 0).sum())} rows masked')
    chunks.append(a); weights.append(fw)
data = np.concatenate(chunks); w = np.concatenate(weights)
keep = w > 0
data, w = data[keep], w[keep]
print(f'rows {len(data)}  inputs {INPUTS}  win-rate {data[:, INPUTS].mean():.3f}  blunder-rate {data[:, INPUTS + 1].mean():.3f}')

dev = torch.device('cuda')
X = torch.tensor(data[:, :INPUTS], device=dev)
Y = torch.tensor(data[:, INPUTS], device=dev)
B = torch.tensor(data[:, INPUTS + 1], device=dev)
W = torch.tensor(w, device=dev)
n = len(X)
perm = torch.randperm(n, device=dev)
val = perm[: max(1, n // 10)]; tr = perm[max(1, n // 10):]

hidden = [int(h) for h in args.hidden.split(',')]
class Net(nn.Module):
    def __init__(self):
        super().__init__()
        layers, last = [], INPUTS
        for h in hidden:
            layers += [nn.Linear(last, h), nn.ReLU()]; last = h
        self.body = nn.Sequential(*layers)
        self.win = nn.Linear(last, 1)
        self.blunder = nn.Linear(last, 1)
    def forward(self, x):
        z = self.body(x)
        return self.win(z).squeeze(-1), self.blunder(z).squeeze(-1)

net = Net().to(dev)
opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
bce = nn.BCEWithLogitsLoss(reduction='none')

def evaluate(idx):
    net.eval()
    with torch.no_grad():
        lw, lb = net(X[idx])
        loss = (bce(lw, Y[idx]) * W[idx]).sum() / W[idx].sum()
        acc = ((lw > 0).float() == Y[idx]).float().mean()
    net.train()
    return loss.item(), acc.item()

best, best_state = float('inf'), None
for epoch in range(args.epochs):
    order = tr[torch.randperm(len(tr), device=dev)]
    for s in range(0, len(order), args.batch):
        i = order[s:s + args.batch]
        lw, lb = net(X[i])
        loss = ((bce(lw, Y[i]) + args.aux * bce(lb, B[i])) * W[i]).sum() / W[i].sum()
        opt.zero_grad(); loss.backward(); opt.step()
    sched.step()
    vl, va = evaluate(val)
    if vl < best: best, best_state = vl, {k: v.detach().clone() for k, v in net.state_dict().items()}
    if epoch % 5 == 0 or epoch == args.epochs - 1:
        print(f'epoch {epoch:3d}  val-loss {vl:.4f}  val-acc {va:.3f}')
net.load_state_dict(best_state)

parts = []
linears = [m for m in net.body if isinstance(m, nn.Linear)] + [net.win]
for m in linears:
    parts.append(m.weight.detach().cpu().numpy().astype(np.float32).reshape(-1))
    parts.append(m.bias.detach().cpu().numpy().astype(np.float32).reshape(-1))
flat = np.concatenate(parts)
flat.tofile(args.out)
json.dump({'hidden': hidden, 'inputs': INPUTS, 'rows': int(n), 'valLoss': best, 'params': int(flat.size), 'data': args.data},
          open(args.out + '.json', 'w'), indent=2)
print(f'saved {args.out} ({flat.size} floats), best val-loss {best:.4f}')
