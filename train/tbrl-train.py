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
args = p.parse_args()
torch.manual_seed(args.seed); np.random.seed(args.seed)

chunks, weights = [], []
for i, path in enumerate(args.data):
    a = np.fromfile(path, dtype=np.float32).reshape(-1, COLUMNS)
    chunks.append(a)
    weights.append(np.full(len(a), args.decay ** (len(args.data) - 1 - i), dtype=np.float32))
data = np.concatenate(chunks); w = np.concatenate(weights)
print(f'rows {len(data)}  win-rate {data[:, FEATURES].mean():.3f}  blunder-rate {data[:, FEATURES + 1].mean():.3f}')

dev = torch.device('cuda')
X = torch.tensor(data[:, :FEATURES], device=dev)
Y = torch.tensor(data[:, FEATURES], device=dev)
B = torch.tensor(data[:, FEATURES + 1], device=dev)
W = torch.tensor(w, device=dev)
n = len(X)
perm = torch.randperm(n, device=dev)
val = perm[: max(1, n // 10)]; tr = perm[max(1, n // 10):]

hidden = [int(h) for h in args.hidden.split(',')]
class Net(nn.Module):
    def __init__(self):
        super().__init__()
        layers, last = [], FEATURES
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
json.dump({'hidden': hidden, 'rows': int(n), 'valLoss': best, 'params': int(flat.size), 'data': args.data},
          open(args.out + '.json', 'w'), indent=2)
print(f'saved {args.out} ({flat.size} floats), best val-loss {best:.4f}')
