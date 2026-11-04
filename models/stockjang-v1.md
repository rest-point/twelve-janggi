# StockJang v1

이 프로젝트의 십이장기 규칙과 `js-v1` 실행 계약에 맞춘 JavaScript 탐색 에이전트다. Stockfish 계열의 고전적인 게임 트리 탐색 기법을 참고한 독립 구현이며, Stockfish 소스·바이너리·NNUE 가중치를 포함하지 않는다. 외부 패키지, 학습 모델, 다운로드, 별도 서버가 필요하지 않다.

## 프로젝트 분석과 연결

- 런타임: Node.js 24.7 이상, ES modules. 웹은 supervisor + 128MiB Worker로 모델을 실행한다.
- 규칙 원본: `src/engine.js`, `twelve-janggi-strict-v2`. 내부 보드는 4×3이며 청은 +x, 홍은 -x 방향으로 전진한다.
- 제출 계약은 루트의 `model.md`에 있다. 이 저장소에는 `models.md`가 없다.
- 기존 모델은 seeded random, 1수 greedy, 깊이 3 legacy minimax다. 모델은 `models/registry.json`에서 CLI와 웹에 함께 등록된다.
- 새 ID는 `stockjang-v1`, version은 `1.0.0`, 화면 이름은 **StockJang classical search**다. 기존 모델과 규칙 엔진은 그대로 사용한다.

`stockjang-v1.mjs`의 `think(request)`를 실행기가 호출한다. 이동과 종국 판정은 `applyAction`, 합법수 생성은 `legalActions`를 사용한다. 왕 안전, 왕 포획 금지, 포로 투입 제한, 승격·후의 자 환원, 안전한 왕 진입, 착수 불가 패배, 반복 무승부를 별도 규칙으로 재구현하지 않는다. 공격 마스크는 수 정렬과 평가에만 사용하며 엔진이 모든 실제 전이를 검증한다.

## 탐색과 평가

1. 루트에서 즉시 승리하는 왕 진입·체크메이트를 먼저 확인한다.
2. 깊이 1부터 반복 심화하며 negamax 알파베타와 principal variation search(PVS)를 수행한다.
3. 이전 최선수, 왕 진입, 포획, 승격, 장군, killer move와 history 점수 순으로 탐색한다.
4. 깊이 끝에서는 제한된 quiescence search로 포획·승격·장군·왕 진입을 추가 확인한다. 장군 중이거나 상대 왕이 끝줄 한 칸 앞에 있으면 조용한 방어 수도 탐색한다.
5. 평가에는 기물·포로 가치, 전진·승격 가능성, 중앙 배치, 공격·방어, 무방비 기물, 왕의 안전한 이동 칸과 진입 압박을 반영한다. 왕은 포획 대상의 물질 가치로 계산하지 않는다. 종국 점수는 모든 정적 평가보다 크며 빠른 승리·늦은 패배를 선호한다.

보드만 같은 캐시는 **수 정렬 전용**이다. 점수 transposition table의 키는 현재 국면 ID와 탐색 경로에서 추가된 국면별 출현 횟수를 정렬한 정확한 문자열이다. 문자열 국면 키를 충돌 없이 정수 ID로 intern한다. 이번 요청 이전의 전체 반복 이력은 고정되고 `applyAction`에 그대로 전달되므로, 과거 이력이 다른 요청이나 출현 횟수가 다른 탐색 경로를 같은 정확값으로 취급하지 않는다. 순서가 달라도 출현 횟수가 같으면 strict-v2 반복 판정은 같다.

모든 캐시·killer·history·국면 ID는 `think` 안에서 생성하고 버린다. Worker가 다음 수나 다른 입력을 받아도 탐색 상태가 남지 않는다. 입력 보드·포로·합법수·반복 이력을 변경하지 않는다. 탐색용 로그만 비워 불필요한 기보 복사를 줄인다.

## 등록 설정과 한도

| config | 등록값 | 의미 |
| --- | ---: | --- |
| `maxDepth` | 24 | 완료할 정규 탐색의 최대 깊이 |
| `maxNodes` | 40000 | 엔진으로 생성한 자식 상태 수의 상한. quiescence·루트 선검사 포함 |
| `maxTimeMs` | 1500 | 자체 탐색 시간 상한 |
| `quiescenceDepth` | 4 | 정규 깊이 끝의 추가 탐색 한도 |
| `tableEntries` | 8192 | 점수 캐시와 수 정렬 캐시 각각의 최대 항목 수. 0이면 두 캐시를 끔 |

깊이·노드·시간 중 먼저 도달하는 한도에서 반환한다. 시간은 요청의 `budgetMs`에서 5% 여유(최소 10ms, 최대 1000ms)를 뺀 값과 `maxTimeMs` 중 작은 값이다. 60초 웹 예산에서도 기본 탐색은 최대 약 1.5초로 제한해 사람 대국과 100국 배치의 대기 시간을 줄인다. 한 번의 엔진 호출·GC·스케줄링까지 선점할 수 있는 하드 실시간 한도는 아니며 최종 watchdog은 기존 실행기가 담당한다.

노드·시간 중단 시 **완료한 마지막 깊이의 최선수**를 반환한다. 깊이 1조차 끝내지 못하면 정렬된 합법수 중 하나를 반환하고 `completedDepth: 0`을 보고한다. 확정된 즉시 승리는 선검사에서 바로 반환한다. `info.nodes`, `info.completedDepth`, `info.searchMs`는 기존 화면·기보 계약을 따른다.

난수를 사용하지 않으므로 `seed`를 소비하지 않는다. 동일한 입력·설정에서 같은 깊이 또는 노드 한도까지 완료하면 결정론적이다. 벽시계 제한이 먼저 걸리면 장비·동시 부하에 따라 완료 깊이와 선택 수가 달라질 수 있다. 비교 시 기보의 노드·깊이·실제 시간도 함께 확인한다.

추가 helper·가중치 파일은 없으며 manifest의 `files`는 빈 배열이다. 기물 점수와 공격 마스크는 자체 코드다. 실제 소스·config·엔진·실행기 해시는 평가 run의 `config.json`에 기록된다. 코드나 등록 설정을 변경해 배포할 때는 새 파일·ID/version으로 등록한다.

## 사용과 검증

앱을 정상 시작 또는 재시작하면 모델 대전과 플레이어 vs AI의 선택 목록에 표시된다. 모델 소개의 공유 텍스트는 앱에서 별도로 작성할 수 있으며 이 Markdown은 실행 artifact의 일부가 아니다.

```powershell
npm run setup
npm test
npm run build

# PowerShell의 npm 인자 전달 차이를 피하기 위해 기존 Node 진입점을 직접 호출한다.
node scripts/evaluate.mjs --a stockjang-v1 --b minimax-v1 --games 100 --concurrency 2 --opening-plies 0 --move-ms 60000 --max-plies 256 --seed 20261031
node scripts/evaluate.mjs --a stockjang-v1 --b greedy-v1 --games 100 --concurrency 2 --opening-plies 0 --move-ms 60000 --max-plies 256 --seed 20261031

npm start
```

`tests/stockjang.test.js`는 양쪽 진영의 즉시 승리, 전수 탐색으로 확인한 3수 강제 승리, 장군 대응과 포로·승격 국면, 입력 불변성, 반복 이력에 따른 선택 변화, 캐시 유무 일치, 요청 간 독립성, 완료 깊이 유지, 짧은 시간·노드 예산, 실제 웹 권한 경계에서의 로드·Worker 재사용을 검증한다. 전체 테스트는 3000 포트 앱이 종료된 상태에서 실행한다.

### 2026-11-04 검증 결과 (한국 시간)

Node.js v26.13.0 / Windows에서 `npm run setup`, 전체 **99개 테스트**, `npm run build`, `git diff --check`가 통과했다. 로컬 HTTP/WebSocket 테스트는 샌드박스의 loopback 접속 제한 때문에 해당 제한 밖에서 재실행해 통과했다. 실제 웹 모델의 permission supervisor/Worker 경계에서도 신규 모델의 로드·연속 요청을 검증했다.

아래는 StockJang의 승/무/패다. 두 실행 모두 첫 수부터 시작(`opening-plies=0`), seed `20261031`, 동시 2국, 수당 60000ms, 최대 256수, 진영/초기 차례 4조합 각 25국이다. **두 실행 모두 100국 전체의 스케줄·설정 해시·기보·시간·통계 재검증에 통과했고, 양쪽 모델 실행 실패는 0건이다.** CLI 결과는 웹 누적 통계에 자동 합산되지 않는다.

| 상대 artifact ID | 승/무/패 | 득점률 | StockJang 평균 / p95 착수시간 | run ID |
| --- | --- | ---: | --- | --- |
| `minimax-v1` | 75 / 25 / 0 | 87.5% | 665 / 1380ms | `2026-11-03T16-04-10-406Z-e796b1d8` |
| `greedy-v1` | 100 / 0 / 0 | 100% | 622 / 1379ms | `2026-11-03T16-07-37-253Z-0b057166` |

minimax전 종국은 착수 불가 승리 50국, 안전한 왕 진입 승리 25국, 반복 무승부 25국이었다. greedy전은 체크메이트 50국과 착수 불가 승리 50국이었다. 이 비교는 탐색 시간과 깊이를 통일한 알고리즘 실험이 아니라 각 모델의 등록된 기본 설정을 사용한 대전이다. StockJang은 기존 minimax보다 더 많은 계산 시간을 사용한다.

재현에 사용한 artifact SHA-256:

- `stockjang-v1`: `3cb9042ce9435dd541525ed0877187ce3cb4bc4b0d7225cacacf62386dfe0b55`
- `minimax-v1`: `cb6df32f457c9be04fd2605b7dfb5c512910d8b7e094ff8f41704dd692fe0b2f`
- `greedy-v1`: `eeff9e3454ea072f23164e882345bdf7b9dd2b100a455d1f67d37ce9bf566a3f`

원본은 로컬 `artifacts/<run-id>/`의 `config.json`, `games.jsonl`, `summary.json`, `report.txt`에 보존했다. run ID의 날짜는 UTC이며 실제 실행일은 한국 시간 11월 4일이다. 이 폴더는 기존 `.gitignore`에 따라 Git에 포함되지 않는다.

## 한계

완전 탐색·해결된 게임의 테이블베이스·학습된 NNUE 모델은 아니다. 제한 깊이의 평가 함수와 quiescence에 수평선 효과가 남으며 최적 수를 보장하지 않는다. null-move pruning이나 late-move reduction처럼 작은 보드의 강제 수·왕 진입·반복에서 검증이 필요한 선택적 가지치기는 사용하지 않는다. 256수 배치 제한은 기존 심판이 적용하며, 이 모델은 사람 대국에도 쓰이므로 그 제한을 내부 종국 규칙으로 가정하지 않는다.

임의 오프닝 0수로 반복한 결정론적 대국은 독립적인 100개 표본이 아니다. 초기 진영/차례 4조합에 대한 재실행 결과로 해석하며, 기력 일반화에는 별도의 다양한 합법 오프닝·전술 국면 비교가 필요하다.
