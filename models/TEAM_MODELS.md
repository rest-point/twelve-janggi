# 세 탐색 모델 등록

이전 Python 프로젝트에서 사용한 Greedy, Minimax+알파베타, MCTS를 팀 환경의 `js-v1` 계약으로 이식했다. **규칙과 좌표는 이 저장소의 `src/engine.js` 및 `twelve-janggi-strict-v2`를 사용한다.** 이전 Python 프로젝트의 왕 포획·진입 후 생존 규칙이나 60판 결과를 이 버전의 성능으로 해석하지 않는다.

| 화면 이름 | registry ID | 방법 | 기본 계산 한도 |
| --- | --- | --- | --- |
| Team Greedy | `team-greedy-v1` | 모든 합법적인 후속 상태의 즉시 평가, 종국 점수 우선 | 한 수 평가, 최대 500ms |
| Team Minimax + Alpha-beta | `team-minimax-v1` | MAX/MIN, 알파베타, 반복 심화, 수 정렬, 전이표 | 최대 깊이 5, 500ms |
| Team MCTS (UCT) | `team-mcts-v1` | 적대적 UCT, 확장, 난수 시뮬레이션, 승·무·패 역전파 | 최대 1,000회 시도, 500ms |

기존 `random-v1`, `greedy-v1`, `minimax-v1`과 파일은 보존했다. 새 모델은 **서버를 정상 재시작하면 기존 모델 선택 목록에 자동으로 추가**된다. 플레이어 vs AI, 모델 조합의 100국 추가 실행에서 선택할 수 있다. 웹의 모델 특징은 DB에 별도로 작성하는 공유 문구이므로 이 문서는 초기 설명 자료다.

## 평가 함수와 탐색

`team-search-common.mjs`는 말·포로 가치(장 500, 상 350, 자 100, 후 600), 기하학적 이동 가능성, 자·왕의 전진, 왕의 체크 위험을 평가한다. 점수는 항상 탐색을 요청한 플레이어 관점이다. 게임이 끝나면 약 ±1,000,000점 또는 무승부 0점을 사용하고, 빠른 승리·늦은 패배를 선호한다. 이 숫자는 승률이 아니다.

Minimax는 완료한 깊이의 결과만 유지한다. 전이표는 국면과 실제 ply, 남은 깊이, **전체 반복 등장 횟수**를 키로 사용하므로 보드만 같은 서로 다른 반복 이력의 점수를 섞지 않는다. 최선 수 정렬·정적 평가 캐시는 이력과 독립적인 정보만 재사용한다. 각 표는 최대 1,000개, 매 `think` 호출마다 새로 만든다. Python판과 달리 이 버전의 캐시 키는 완전한 문자열 키이며 Zobrist 해싱을 사용하지 않는다.

MCTS는 루트 플레이어의 승리=1, 무승부=0.5, 패배=0을 누적한다. 루트 쪽 차례의 UCT는 `Q + sqrt(2 ln N / n)`, 상대 차례는 `(1−Q) + sqrt(2 ln N / n)`이다. 즉시 끝나는 승리 수를 먼저 확인하고, 그 외에는 방문 수가 많은 루트 자식을 고른다. 방문 수 동점이면 Q로 비교한다.

시뮬레이션 수는 제공된 uint32 seed를 쓰는 LCG로 정한다. 시뮬레이션은 무작위 합법 수를 두며 실제 엔진의 체크메이트·안전한 진입·반복 판정이 적용된다. 안전장치로 시뮬레이션 한 번당 최대 256개의 추가 수를 진행한다. 이 안에서 끝나지 않거나 시간이 끊기면 **표본을 버리고 승·무·패에 넣지 않는다.** 이것은 심판의 256수 배치 무승부 판정과 별개이며 사람 대국에 전체 수 제한을 새로 도입하지 않는다.

`analyze(request)`는 검증용 점수/표본 통계를 제공하고, 실제 `think(request)`는 계약상 `action`과 `info.nodes/completedDepth/searchMs`만 반환한다. MCTS의 `completedDepth`는 실제 방문한 트리 최대 깊이이며 Minimax의 균일한 완료 깊이와 의미가 다르다. 실제 착수 시간은 팀 실행기가 별도로 측정한다.

## 시간·실행 파일

모든 모델은 `min(config.thinkMs, budgetMs − 통신 여유)`를 사용한다. 통신 여유는 최소 10ms, 예산의 약 10%, 최대 250ms다. 아주 작은 예산에는 첫 합법 수를 반환한다. 이력·입력 배열을 직접 수정하지 않으며, 외부 프로세스·네트워크·DB·비밀 환경변수를 사용하지 않는다.

세 entry 파일은 같은 `team-search-common.mjs`를 import하므로 registry의 `files`에 선언했다. 실행 config를 바꾸거나 helper를 수정해 다시 배포할 때는 [model.md](../model.md)에 따라 **세 모델 중 영향을 받는 모델에 새 ID/version**을 추가한다. 이미 DB에 고정한 ID의 코드를 교체하지 않는다.

## 실행과 검증

Node.js **24.7 이상**을 사용한다. 시스템 기본 Node가 22이면 먼저 24 이상을 선택한다. 실제 `.env`나 DB는 Git에 추가하지 않는다.

```powershell
npm ci
npm run setup
npm test
npm start
```

별도 CLI 연결 확인은 각 조합을 색상·선공 네 경우로 검증한다. 임의 오프닝 없이 첫 수부터 시작한다.

```powershell
npm run evaluate -- --a team-greedy-v1 --b team-minimax-v1 --games 4 --concurrency 2 --opening-plies 0 --move-ms 1000 --max-plies 256
npm run evaluate -- --a team-minimax-v1 --b team-mcts-v1 --games 4 --concurrency 2 --opening-plies 0 --move-ms 1000 --max-plies 256
npm run evaluate -- --a team-mcts-v1 --b team-greedy-v1 --games 4 --concurrency 2 --opening-plies 0 --move-ms 1000 --max-plies 256
```

4국은 연결·규칙·기보 확인용이다. 모델 성능 비교는 같은 설정으로 충분한 대국을 실행해 별도로 보고한다. 고정 횟수·시드의 MCTS는 재현할 수 있지만 시간 제한에 걸리면 기기 부하에 따라 탐색량이 달라질 수 있다. 셋 모두 최적 플레이나 무패를 보장하지 않는다.

### 이 브랜치의 확인 결과

2026-11-04, Windows / Node 24.22.1에서 다음을 확인했다.

- 일반 테스트 97개 통과. 기존 장시간 배치 테스트 5개는 별도로 통과했다. 전체 병렬 실행 시 100→200국 테스트가 한 번 대기 시간 초과를 보여 자원 경합을 줄여 순차 검증했다.
- 세 모델의 모든 조합을 색상·선공 네 경우씩 총 12국 실행하고 전체 기보·시간·종료 결과를 재검증했다. 모델 예외·불법수·시간 초과는 0건이었다. 연결 확인 조건은 수당 300ms, 임의 오프닝 0수, 최대 256수, seed 20261104다.
- 실제 웹 `ModelProcess`의 권한 제한 안에서 세 모델이 로드되고 수를 반환했다. `/api/models`에서도 세 화면 이름이 표시됐다. 기존 웹 화면은 registry를 자동으로 읽으므로 화면 코드는 변경하지 않았다.
- 빌드 및 별도 코드 리뷰를 마쳤다. Minimax는 추가 도달 국면 14개에서 깊이 3 완전 탐색과 일치했다.

원래 모델 버전 불변성 테스트의 ‘등록 모델은 3개’ 고정 가정은 등록 전후 버전 수가 같아야 한다는 검증으로 바꿨다. 기존 3개 모델이 보존되며 새 3개를 더할 수 있는 조건을 확인한다.

알고리즘 참고: [Berkeley 게임 탐색](https://inst.eecs.berkeley.edu/~cs188/textbook/games/summary.html), [Berkeley MCTS](https://inst.eecs.berkeley.edu/~cs188/textbook/games/monte-carlo.html). Minimax의 반복 심화·수 정렬·TT 경계 종류는 [Stockfish 탐색 코드](https://github.com/official-stockfish/Stockfish/blob/ff3a6c508ed731f0dcf253f4ddf646df19a62f84/src/search.cpp)를 참고한 Python 구현을 바탕으로 독립적으로 옮겼다. Stockfish 코드·실행 파일·NNUE 가중치를 복사하지 않았다.
