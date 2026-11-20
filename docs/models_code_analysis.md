# 십이장기 모델 알고리즘 구현 검증

등록된 12개 모델에서 알고리즘의 핵심 연산이 실제 착수나 학습으로 이어지는지를 확인했다. 본문 코드는 저장소 커밋 `1d2a96e`에서 발췌했다. 코드가 예측하는 동작을 전수 계산, 설정·가중치 대조, 저장소 테스트 48개로 확인했다. `twelve-janggi-algorithm-validation.pdf`에서 가져온 결과에는 쪽수를 표시했다.

## M01 Seeded Random `random-v1`

**핵심 알고리즘 : Random 알고리즘**

### 코드 구현 검증

```js
export function think({ legalActions, seed }) {
  let value = seed >>> 0;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return { action: legalActions[(value >>> 0) % legalActions.length] };
}
```

**Random 알고리즘 구현 확인.** `seed >>> 0`으로 시작한 값에 XOR 시프트를 세 번 적용하고, 그 결과의 나머지를 합법수 배열의 인덱스로 직접 사용한다. 시작판의 합법수 배열을 고정하고 시드 `0, 1, 2, 3, 17, 1234`를 두 번씩 넣었을 때 두 실행 모두 인덱스 `0, 1, 2, 3, 0, 3`을 반환했다. [착수 코드](../models/random.mjs#L1)

## M02 One-ply Greedy `greedy-v1`

**핵심 알고리즘 : Greedy 알고리즘 (1수)**

### 코드 구현 검증

```js
for (const candidate of legalActions) {
  const next = applyAction(state, candidate, false);
  let score = 0;
  if (next.winner !== null) score = next.winner === 'draw' ? 0 : next.winner === side ? 1e6 : -1e6;
  else {
    for (const piece of next.board) if (piece) score += (piece.side === side ? 1 : -1) * values[piece.kind];
    for (let s = 0; s < 2; s++) for (const kind of next.hands[s]) score += (s === side ? 1 : -1) * values[kind] * 0.8;
  }
  if (score > best) { best = score; action = candidate; }
}
```

**Greedy 알고리즘 구현 확인.** 후보마다 `applyAction`을 한 번 호출하고 종국이나 기물·포로 점수를 계산한다. `score > best`에서만 착수를 갱신하므로 한 수 직후의 최대 점수를 고르고, 동점이면 먼저 본 수를 유지한다. 별도로 모든 1수 후보를 채점한 결과와 모델의 착수가 64개 국면에서 모두 일치했다. [착수 코드](../models/greedy.mjs#L3)

## M03 Legacy Minimax Normal `minimax-v1`

**핵심 알고리즘 : Minimax 알고리즘 (깊이 3) + 알파–베타 가지치기**

### 코드 구현 검증

```js
const side=state.turn,depth=difficulty==='hard'?4:difficulty==='easy'?1:3;
// …
if(!d||s.winner!==null||++nodes>22000)return score(s,side,state.ply);
const maximizing=s.turn===side;
// …
for(const a of aa){const v=search(applyAction(s,a,false),d-1,alpha,beta);best=maximizing?Math.max(best,v):Math.min(best,v);if(maximizing)alpha=Math.max(alpha,best);else beta=Math.min(beta,best);if(beta<=alpha)break;}
// …
for(const a of actions){const value=search(applyAction(state,a,false),depth-1,-Infinity,Infinity);if(value>best){best=value;chosen=a;}}
```

**깊이 3 Minimax 구현 확인.** 등록값 `normal`은 `depth=3`이 된다. 루트 첫 수를 적용한 뒤 `depth-1=2`로 들어가고, 재귀에서도 매번 깊이를 줄인다. `s.turn===side`이면 최댓값, 상대 차례면 최솟값을 고른다. 알파–베타 창이 닫히면 가지를 생략하고, 종국이나 노드 제한에서는 일찍 평가한다. 가지치기 없이 깊이 3까지 계산한 결과와 64개 국면에서 모두 일치했다. 같은 국면에서 깊이 1로 줄였을 때는 36개에서 착수가 달라졌다. [등록 설정](../models/registry.json#L4) · [모델 진입점](../models/minimax.mjs#L2) · [깊이와 재귀](../src/engine.js#L141)

## M04 Team MCTS `team-mcts-v1`

**핵심 알고리즘 : 몬테카를로 트리 탐색(MCTS) + UCT + 무작위 롤아웃**

### 코드 구현 검증

```js
const q=mean(child);
const uct=child.visits===0?Infinity:(parent.state.turn===perspective?q:1-q)
  +Math.sqrt(2*Math.log(Math.max(1,parent.visits))/child.visits);
```

**UCT가 상대의 선택까지 반영한다.** 평균 보상 `q`에 방문 횟수 기반 탐색 보너스를 더하고, 미방문 자식은 우선한다. 보상을 루트 관점으로 저장하므로 상대 차례에는 `1-q`를 쓴다. 방문이 각 20회이고 루트 승리가 각각 18회와 2회인 두 후보를 넣었을 때, 부모의 착수 진영만 바꾸자 선택이 뒤집혔다. [UCT 선택](../models/team-mcts-v1.mjs#L4) · [관점 전환 테스트](../tests/team-models.test.js#L59)

```js
const actions=legalActions(state);
state=applyAction(state,actions[Math.floor(random()*actions.length)],false);
// …
if(state.winner===null){discarded++;continue;}
completed++;
for(const ancestor of path) {
  ancestor.visits++;
  if(state.winner==='draw')ancestor.draws++;else if(state.winner===ctx.side)ancestor.wins++;else ancestor.losses++;
}
```

**롤아웃 결과가 방문 수와 착수에 반영된다.** 미확장 수를 펼친 뒤 시드 기반으로 합법수를 무작위 선택한다. 종국까지 간 표본만 경로 전체에 반영한다. 시작판에서 시드 42로 완료된 40회의 루트 후보 방문 수는 `15·11·8·6`이었고, 모델은 15회 방문한 수를 골랐다. [확장·롤아웃·최종 선택](../models/team-mcts-v1.mjs#L33)

## M05 StockJang `stockjang-v1`

**핵심 알고리즘 : 반복 심화 + 주 변형 탐색(PVS) + 전이표(TT) + 정지 탐색**

### 코드 구현 검증

```js
if (first) score = -search(next, depth - 1, -beta, -alpha, ply + 1);
else {
  // Principal variation search: scout later moves before a full window.
  score = -search(next, depth - 1, -alpha - 1, -alpha, ply + 1);
  if (score > alpha && score < beta) score = -search(next, depth - 1, -beta, -alpha, ply + 1);
}
```

- **PVS.** 첫 후보는 전체 창에서 읽고, 이후 후보는 폭 1의 창으로 먼저 검사한다. 현재 최선보다 좋고 상한 안에 있으면 전체 창으로 다시 읽는다. 첨부 PDF 9쪽의 실행 추적에서 좁은 창 분기가 84회 실행됐다. 방어 응수를 모두 계산한 청·홍 대칭 국면에서 모델은 각각 유일한 3수 강제승 `b1→b2`와 `b4→b3`를 골랐다. [PVS 재귀](../models/stockjang-v1.mjs#L175) · [강제승 테스트](../tests/stockjang.test.js#L50)
- **반복 심화.** `depth=1`부터 깊이를 늘리고, 루프 안의 모든 루트 후보 평가가 끝난 뒤 `chosen`과 `completedDepth`를 갱신한다. 노드 한도로 중단시킨 테스트에서 마지막으로 완료한 깊이의 결과를 반환했다. [깊이 루프](../models/stockjang-v1.mjs#L228) · [중단 테스트](../tests/stockjang.test.js#L106)
- **전이표.** `contextKey`에는 현재 판과 탐색 경로의 반복 횟수가 들어간다. `cached.depth >= depth`인 경우 정확값이나 현재 창을 닫는 상·하한을 재사용한다. 캐시의 수는 정렬에도 반영된다. 같은 보드에 반복 이력을 달리했을 때 착수가 달라졌고, 같은 이력에서는 캐시를 끄거나 켜도 테스트 결과가 일치했다. [이력 키](../models/stockjang-v1.mjs#L116) · [캐시 사용](../models/stockjang-v1.mjs#L179) · [캐시·이력 테스트](../tests/stockjang.test.js#L80)
- **정지 탐색과 평가.** `depth <= 0`에서 `quiescence`로 들어가 포획·장군·승급·왕 진입을 더 읽는다. 장군이나 왕 진입 위협에 대응해야 하면 조용한 방어수도 포함한다. 깊이 한도에서는 `evaluate`가 기물 가치·전진·공격 범위 등을 합산한 점수를 반환한다. 시작판에서 기본 깊이를 1로 고정하고 정지 탐색 깊이만 0에서 4로 바꾸자 `b2→b3`에서 `c1→c2`로 착수가 바뀌었다. [평가식](../models/stockjang-v1.mjs#L33) · [정지 탐색 호출](../models/stockjang-v1.mjs#L175) · [전술 후보와 방어수](../models/stockjang-v1.mjs#L150)

## M06 AlphaZero Gumbel-trained `azero-v2`

**핵심 알고리즘 : 정책·가치 MLP + PUCT 탐색 + Gumbel 자기 대국 학습**

### 코드 구현 검증

```js
const u = (node.N[i] ? node.W[i] / node.N[i] : fpu) + explore * node.P[i] / (1 + node.N[i]);
// …
value = -value;
const up = path[d], i = taken[d];
up.N[i]++; up.W[i] += value; up.n++; up.sum += value;
```

**실전 PUCT가 정책과 가치를 쓴다.** 신경망이 만든 합법수 사전확률 `P`를 탐색 보너스에 곱하고, 국면 가치는 차례가 바뀔 때마다 부호를 뒤집어 `W`에 누적한다. 진입점은 `root.N`의 최댓값에 해당하는 수를 반환한다. 시작판에서 800회 탐색했을 때 배포 가중치는 방문 수 `[100, 57, 597, 46]`과 착수 `b2→b3`를, 0 가중치는 `[229, 196, 196, 179]`와 `b1→c2`를 냈다. [신경망 출력](../models/azero-core.mjs#L190) · [PUCT와 역전파](../models/azero-core.mjs#L203) · [배포 진입점](../models/azero-v2.mjs#L4)

```js
let alive = acts.map((_, i) => i).sort((x, y) => base[y] + gumbel[y] - base[x] - gumbel[x]).slice(0, budget < 64 ? 4 : 16);
// …
alive.sort((x, y) => q[y] - q[x]);
alive = alive.slice(0, Math.max(1, Math.ceil(alive.length / 2)));
// …
return { pick: acts[n > 1 ? alive[0] : 0], target: raw.map(x => x / sumRaw), q, N };
```

**Gumbel 자기 대국 결과가 학습 목표가 된다.** 초기에는 정책 로짓과 Gumbel 잡음의 합으로 후보를 뽑고, 매 라운드 탐색 가치 `q`로 재정렬해 절반을 남긴다. 자기 대국 코드가 정책 목표 `r.target`과 종국 결과 `z`를 저장하고, 역전파가 정책 교차 엔트로피와 가치 제곱 오차를 계산한다. 정책 목표의 합이 1인지를 확인하는 테스트와 수치 미분 테스트가 통과했다. 첨부 PDF 9쪽의 단일 표본 재현에서도 가중치 17,871개가 바뀌고 합산 손실이 `0.72758589 → 0.72117084`로 감소했다. [Gumbel 탐색](../train/gumbel.mjs#L7) · [자기 대국 표본](../train/gumbel-worker.mjs#L36) · [손실과 역전파](../train/backprop.mjs#L5) · [기울기 테스트](../tests/azero.test.js#L41) · [정책 목표 테스트](../tests/azero.test.js#L78)

## M07 League-Trained Packed MLP `packed-gemm-puct-v2`

**핵심 알고리즘 : Packed GEMM 배치 추론 + 동적 PUCT + 가상 손실 + DFPN**

### 코드 구현 검증

```js
const h2 = packedGemm(h1, SECOND, rows, h1);
const h3 = packedGemm(h2, THIRD, rows, h2);
const hv = packedGemm(h3, VALUE, rows);
```

**배치 추론.** 한 호출에서 복수 국면을 평가한다. 행렬곱은 국면 4개와 출력 채널 4개씩 묶어 편향·ReLU·잔차 덧셈을 결합한다. 전용 체크포인트를 사용해 24개 국면의 정책 확률과 국면 가치를 국면별 계산과 대조했을 때 최대 절대 오차는 0이었다. [체크포인트 로딩](../models/packed-gemm-puct-v2.mjs#L5) · [배치 행렬곱](../models/packed-gemm-policy-value-v2.mjs#L33)

```js
const visits = node.N[i] + virtualLoss * node.V[i];
// Reservations contribute a temporary zero-win sample, lowering Q.
const q = visits ? node.W[i] / visits : firstValue;
const score = q + exploration * node.prior[i] / (1 + visits);
```

**동적 PUCT와 가상 손실.** `exploration`은 노드의 방문 수에 따라 달라진다. 예약 횟수 `V`는 두 분모에 들어가 같은 가지에 연속으로 탐색을 배정할 가능성을 낮춘다. 배치 결과를 반영할 때는 예약을 해제한다. 시작판에서 DFPN을 끄고 64회씩 탐색했을 때, 가상 손실 계수만 `0.1 → 4`로 올리자 후보별 방문 수가 `[16, 10, 29, 9] → [16, 10, 27, 11]`로 바뀌었다. 두 실행 모두 종료 시 남은 예약은 0이었다. [탐색 계수와 예약](../models/packed-puct-search-v2.mjs#L97) · [작업 수집과 반영](../models/packed-puct-search-v2.mjs#L151)

```js
const childPhi = orNode ? Math.min(phi, second + 1) : phi - node.pn + best.pn;
const childDelta = orNode ? delta - node.dn + best.dn : Math.min(delta, second + 1);
```

**DFPN 강제승 채택.** 공격자는 OR, 수비자는 AND로 증명·반증 수를 갱신하고, 자식마다 새 임계값을 정해 깊이 우선으로 읽는다. 호출부는 `win`만 강제승으로 채택한다. 유일한 3수 강제승 국면에서는 루트 DFPN 한도 3,000노드로 `b1→b2`를 확정해 PUCT와 신경망 추론을 0회 수행했다. DFPN을 끈 대조 실행은 PUCT를 8회 수행했고 최대 추론 배치 크기는 8이었다. [AND·OR 갱신](../models/dfpn-proof-v1.mjs#L15) · [깊이 우선 임계값](../models/dfpn-proof-v1.mjs#L54) · [강제승 채택](../models/packed-puct-search-v2.mjs#L51)

## M08 Full Tablebase Minimax `tablebase-minimax-reply-v2`

**핵심 알고리즘 : 테이블베이스 Minimax + 상대 응수 분석(Reply Profile) + PVS**

### 코드 구현 검증

```js
const bestTier = Math.max(...candidates.map(candidate => tier(candidate.value)));
let eligible = candidates.filter(candidate => tier(candidate.value) === bestTier);
// …
if (result.value === -1 || result.value === null) risk++;
if (result.value === 1 && result.certain) upside++;
// …
profiles.sort((a, b) => a.risk - b.risk || b.upside - a.upside);
// …
const result = pvs({ ...request, legalActions: eligible.map(candidate => candidate.action), budgetMs: Math.max(0, budget - elapsed),
  config: { ...config, maxTimeMs: Math.max(0, maxTime - elapsed) } });
```

- **테이블베이스 등급이 후보를 제한한다.** 실제 종국을 먼저 판정하고, 테이블의 착수자 관점 값을 모델 진영으로 변환한다. 전체 후보를 승·무·미등록·패 순으로 분류해 가장 높은 등급만 남긴다. `G002` 7수 직후 홍의 네 합법수는 청 관점에서 `263, 265, 269, 1`이었다. 청 승리인 앞 세 수가 제외되고 홍의 유일한 무승부 수 `b4→a3`만 남았다. [테이블 조회와 등급](../models/tablebase-minimax-reply-v2.mjs#L23) · [G002 기보](./models_replays.md#m08-m09-g002)
- **상대 응수 분석이 후보를 좁히고 PVS가 남은 동률을 푼다.** 모든 동률 후보의 응수 조사가 끝났을 때만 패배·미등록 응수 비율이 낮은 수, 확정 승리 응수 비율이 높은 수 순으로 좁힌다. PVS에는 남은 `eligible`만 전달한다. 시작판에서 응수 분석을 허용하면 후보가 하나로 좁혀졌고, 분석 시간만 0으로 설정하면 PVS가 깊이 4까지 진행됐다. 첨부 PDF 10쪽에서도 동률 국면 82개 중 69개에서 응수 분석으로 후보가 하나가 됐다. 별도 테스트에서는 창 폭과 전이표 설정을 달리해도 PVS가 200개 국면에서 깊이 3 전수 계산의 최적수를 골랐다. [응수 순위와 PVS 호출](../models/tablebase-minimax-reply-v2.mjs#L65) · [탐색 창 조정](../models/pvs-aspiration-v1.mjs#L200) · [전수 대조 테스트](../tests/pvs-search.test.js#L29)
- **예산 예외.** 유효 예산이 10ms 이하면 루트 조회 전에 PVS로 넘어간다. `G001`에서 일반 예산은 무승부 조회값 `1`인 수를, 직접 전달한 1ms는 상대 승리 조회값 `263`인 수를 반환했다. [예산 분기](../models/tablebase-minimax-reply-v2.mjs#L10) · [G001 기보](./models_replays.md#m08-m09-g001)

## M09 JANGGUN `team-contender-v2`

**핵심 알고리즘 : 반복 이력을 반영한 테이블베이스 평가 + PVS + 가치 MLP + DFPN**

### 코드 구현 검증

```js
if (outcome?.terminal) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply);
if (outcome?.certain) return outcome.outcome === 0 ? 0 : outcome.outcome * (MATE - ply - outcome.distance);
// …
const stand = inCheck ? null : outcome ? outcome.outcome : policy(position, moves).value;
```

- **테이블베이스와 가치 평가.** 실제 종국과 확정된 테이블 값을 먼저 반환하고, 조회값이 없고 장군 상태가 아닌 말단에서는 신경망 가치 출력을 쓴다. 반복 이력 때문에 확실성이 낮아진 승리 후보와 확정 무승부를 맞붙인 테스트에서는 후자를 골랐다. 조회값이 없는 조건에 후보별 가치를 주입했을 때 평가 순위가 바뀌면 착수도 바뀌었다. [반복 이력과 판정](../models/team-contender-search-v2.mjs#L10) · [말단 평가](../models/team-contender-search-v2.mjs#L171) · [무승부 선택 테스트](../tests/team-contender-v2.test.js#L7)
- **PVS와 DFPN.** 깊이마다 `rootSearch`를 호출하며, 후순위 수는 `-alpha-1, -alpha`의 좁은 창에서 검사한 뒤 조건이 맞으면 전체 창에서 다시 읽는다. 루트 조회를 미등록으로 설정하고 실제 DFPN을 연결한 대조에서 81개 노드를 조사해 `b1→b2`를 강제승으로 확정하고 신경망 평가 전에 반환했다. [DFPN 진입과 반환](../models/team-contender-search-v2.mjs#L113) · [PVS와 반복 심화](../models/team-contender-search-v2.mjs#L234)

```js
const logits = new Float64Array(legalMoveCodes.length);
// …
return { value: Math.round(Math.tanh(value) * 10000), priors: logits };
```

```js
const priors = Array.isArray(raw?.priors) && raw.priors.length === moves.length
  ? raw.priors.map(item => finite(item, 0)) : moves.map(() => 0);
```

- **정책 수 정렬은 배포 경로에서 무효다.** `Array.isArray`가 `Float64Array`를 거부해 정책 점수가 모두 0으로 바뀐다. 같은 점수 `[0, 0, 0, 1000000]`를 보통 배열과 `Float64Array`로 각각 주입했을 때 평가 순서가 `4·1·2·3 → 1·2·3·4`, 착수가 `c1→c2`에서 `b1→c2`로 바뀌었다. 숫자로 전달되는 가치 출력은 앞의 말단 평가에서 사용된다. [신경망 반환값](../models/team-contender-v2.mjs#L14) · [자료형 검사와 정렬](../models/team-contender-search-v2.mjs#L81)
- **예산 예외.** `G002` 7수 직후 정상 예산에서는 유일한 무승부 수 `b4→a3`를 골랐다. 1ms 직접 호출에서는 탐색 전에 반환한 첫 합법수 `b4→c4`가 상대 승리 조회값 `263`으로 이어졌다. [탐색 전 반환](../models/team-contender-search-v2.mjs#L64) · [G002 기보](./models_replays.md#m08-m09-g002)

## M10 Duri `duri-v1`

**핵심 알고리즘 : 사전 전술 검사 + AlphaZero v1 정책·가치 PUCT + MCTS-Solver**

### 코드 구현 검증

```js
function updateProof(node) {
  let allSolved = true, best = -1;
  for (const child of node.children) {
    if (!child || child.proven === null) { allSolved = false; continue; }
    best = Math.max(best, child.proven === 0 ? 0 : -child.proven);
    if (best === 1) { node.proven = 1; return; }
  }
  if (allSolved) node.proven = best;
}
```

- **사전 전술 검사.** 각 후보를 두고 상대의 합법 응수까지 확인해 즉시 승리 수를 채택하거나 상대의 즉시 승리를 허용하는 수를 걸러낸다. 탐색 한도를 1회로 둔 테스트에서도 유일한 방어수 `a1→b2`를 골랐다. [전술 검사](../models/soljang-search-v1.mjs#L95) · [즉시 위협 방어 테스트](../tests/duri-v1.test.js#L24)
- **v1 정책·가치 PUCT.** `select`가 가치 평균과 정책 사전확률에 기반한 탐색 보너스를 더한다. 시작판을 64회 읽으면 배포 가중치의 방문 수는 `[15, 13, 23, 13]`, 0 가중치는 `[16, 16, 16, 16]`이었고 착수도 달라졌다. [v1 가중치 로딩](../models/duri-v1.mjs#L1) · [사전확률과 PUCT](../models/soljang-search-v1.mjs#L58)
- **MCTS-Solver 증명 전파.** 상대 패배가 확정된 자식 하나로 부모 승리를 확정한다. 무승부·패배는 모든 자식이 확정된 뒤 판정한다. 로컬에서 유일한 3수 강제승 국면을 입력하자 99회 탐색 후 루트 `proven=1`을 기록하고 `b1→b2`를 반환했다. [증명 갱신](../models/soljang-search-v1.mjs#L72) · [역전파에서 호출](../models/soljang-search-v1.mjs#L149)

## M11 TB-RL `tbrl-v2`

**핵심 알고리즘 : 테이블베이스 필터링 + 반복 회피 + 리그 학습 가치 MLP**

### 코드 구현 검증

```js
const bestTier = Math.max(...children.map(c => tierOf(c.value)));
let eligible = children.filter(c => tierOf(c.value) === bestTier);
// …
const noClaim = eligible.filter(c => !c.oppRepeat);
if (noClaim.length) eligible = noClaim;
const fewest = Math.min(...eligible.map(c => c.repeat));
eligible = eligible.filter(c => c.repeat === fewest);
```

**테이블베이스와 반복 처리.** `classify`가 실제 종국과 테이블 조회값으로 후보를 평가한다. 최상위 등급을 먼저 남긴 뒤, 가능하면 즉시 종국 무승부와 상대의 다음 수 반복 무승부를 피하고 반복 횟수가 가장 적은 수를 유지한다. 로컬 무승부 국면 34개 모두에서 필터를 통과한 후보는 무승부 이상이었다. [종국과 테이블 조회](../models/tbrl-core.mjs#L141) · [등급과 반복 필터](../models/tbrl-core.mjs#L259)

```js
for (const c of eligible) {
  c.score = value(candidateInput(state, c, table, trap)) + 1e-6 * random(); // seeded tie-break only
  if (c.score > best) { best = c.score; child = c; }
}
```

**가치망은 필터를 통과한 후보만 순위화한다.** `for (const c of eligible)` 안에서만 MLP 점수로 착수를 갱신하므로 하위 등급이 다시 선택될 수 없다. 첨부 PDF 12쪽에서는 동률 국면 79개의 MLP 계산을 별도로 재현해 79개 모두 실제 착수와 일치했고, 가치 항을 빼자 61개에서 착수가 달라졌다. [가중치와 후보 순위](../models/tbrl-v2.mjs#L9)

## M12 Full Tablebase + Reply Policy MLP `tablebase-reply-mlp-v1`

**핵심 알고리즘 : 테이블베이스 필터링 + TB-RL 가치 MLP + 응수 정책 MLP**

### 코드 구현 검증

```js
const { tier, eligible } = safeCandidates(children, { avoidRepeat: !useProfile || (config.avoidRepeat ?? false) });
// …
const position = ranked.length && tier === 0 && replyWeight > 0 ? new FastPosition(state) : null;
```

**테이블베이스가 적용 범위를 고정한다.** `eligible`이 먼저 정해지고, 응수 분석은 그 후보가 여럿이고 등급이 무승부(`tier === 0`)일 때만 켜진다. 로컬 무승부 국면 34개에서 응수 가중치를 켜거나 꺼도 두 설정 모두 무패 등급 안에서 착수했다. [등급 필터와 응수 분석 조건](../models/tablebase-reply-mlp-v1.mjs#L18)

```js
const weight = Math.exp(Math.min(8, Math.max(-8, replyLogit(row) / temperature)));
// …
const probability = (1 - uniformMix) * win / total + uniformMix * countWin / replies.length;
// …
scored.push((1 - replyWeight) * baseScore
  + replyWeight * (score - 0.12 * candidate.oppRepeat - 0.055 * (candidate.repeat - 1)) + 1e-7 * random());
```

**응수망 출력이 실제 순위를 바꾼다.** 상대 응수별 로짓을 지수 가중치로 바꾸고, 우리 승리로 이어지는 응수의 가중 비율과 균등 비율을 섞는다. 반복 등 보정을 거쳐 `replyWeight`로 TB-RL 가치와 합치며, 전체 후보 평가를 마쳤을 때 결과를 반영한다. 기본 설정에서 시간이 부족하면 가치 MLP로 미리 고른 수를 유지한다. 첨부 PDF 12쪽에서는 응수 가중치만 `0 → 0.75`로 바꿨을 때 82개 중 8개 국면에서 세 차례 모두 두 설정의 착수가 달랐다. [두 가중치 로딩](../models/tablebase-reply-mlp-v1.mjs#L8) · [응수 로짓과 합산](../models/tablebase-reply-mlp-v1.mjs#L30) · [완료와 시간 초과](../models/tablebase-reply-mlp-v1.mjs#L70)
