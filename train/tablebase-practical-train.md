# 전체 테이블베이스 모델의 실전 수 순위 학습

`tablebase-minimax-reply-v2`가 판정한 강제승과 무승부를 보존한다. 별도 신경망은 이론상 무승부인 국면에서 무승부를 유지하는 수의 순위만 바꾼다. 테이블의 승·패·미등록 국면과 시간 예산 안에 후보 비교를 마치지 못한 국면은 기존 모델에 넘긴다.

Node.js는 공식 심판과 전체 테이블을 사용해 같은 국면의 여러 수를 실제로 이어 둔다. 학습 상대는 One-ply Greedy, StockJang, Packed PUCT다. 대국이 끝나거나 반복 이력을 감안해 강제승을 확인하면 승리 전환을 기록한다. 학습 수 제한에 도달한 사례는 그 제한 안에서 전환하지 못한 것으로 센다. 각 후보는 상대 응수의 승패 분포, 포획 선호, 기물 평가, 왕 진입, 체크 및 반복 이력 등 13개 특징을 가진다. Python은 한 국면 안에서 상대별 승리 전환을 더 자주 만든 수에 높은 점수를 주는 32유닛 MLP를 학습한다.

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe" `
  train/tablebase-practical-train.py --out artifacts/tablebase-practical-01
```

Python에 NumPy가 필요하다. 기본값은 학습용 고유 국면 384개, 검증용 64개, 작업자 4개다. 계산 규모는 `--positions`, `--validation-positions`, `--workers`, `--train-plies`로 조절한다. 기존 `dataset.json`을 `--dataset`으로 다시 사용할 수 있다.

검증은 학습에 포함되지 않은 무승부 국면에서 진영을 교대한다. 기존 모델과 새 가중치를 적용한 모델을 각각 StockJang, Packed PUCT, Legacy Minimax Normal, Team MCTS와 비교한다. Legacy Minimax Normal과 Team MCTS는 학습 상대에 포함되지 않는다. 기본 설정으로 모델당 512국이다. `report.json`에는 승·무·패, 승률 차이의 국면별 95% 부트스트랩 구간, 상대별 결과, 수 선택 시간의 95백분위와 수 제한 도달 횟수가 들어간다. `passed`는 최소 48개 검증 국면에서 새 가중치의 패배가 0건이고 승률 차이의 95% 구간 하한이 0보다 높으며, 학습에 쓰지 않은 상대의 합산 승률도 떨어지지 않았음을 뜻한다.

`weights.json`은 학습된 후보 체크포인트다. `createPracticalRanker`가 이 파일을 읽는 검증 모델을 구성한다. 이 과정은 앱 등록 파일이나 배포 모델의 가중치를 갱신하지 않는다.
