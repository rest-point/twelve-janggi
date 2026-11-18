# 모델 적용 안내

팀원이 만든 모델을 이 환경의 `js-v1` 계약으로 연결하고, 불변 실행 버전으로 등록한 뒤 비교하는 절차다. 설치·운영·전체 게임 규칙은 [README](README.md)를 참고한다.

## 1. 가져오기 전 확인

현재 직접 실행할 수 있는 것은 **검토한 JavaScript ES module(`.mjs`)**이다. 기존 예제는 `models/random.mjs`, `models/greedy.mjs`, `models/minimax.mjs`다. Python/C++/Rust 실행 파일이나 학습 프레임워크 모델은 그대로 넣을 수 없다. JS로 이식하거나 별도의 어댑터 구현·검증이 필요하다. 웹에서는 임의 코드·URL·셸 명령을 등록하지 않는다.

모델은 현재 규칙 **`twelve-janggi-strict-v2`**를 따라야 한다. 특히 왕 포획 불가, 자기 왕 안전, 안전한 왕 진입 즉시 승리, 합법수 없음 패배, 상대 끝줄 포로 투입 금지, **3회 반복 무승부**를 확인한다. 모델 배치는 **최대 256수 무승부**, 수당 제한은 **60초**다.

다음 파일을 준비한다.

- `think(request)`를 내보내는 모델 진입 파일.
- 실제 사용하는 모든 helper·평가 함수·가중치 파일.
- 탐색 깊이/시간/난수/평가 가중치 등 실행 config와 버전 정보.

앱을 정상 종료하고 작업한다. 기존 발표 모델의 파일과 ID를 덮어쓰지 않는다. 등록 후 앱을 시작하면 코드/config 해시가 DB에 고정된다. **골격을 먼저 앱에 공개한 뒤 같은 ID로 알고리즘을 교체하면 불변 버전 오류가 발생한다.**

## 2. 모델 파일과 registry 만들기

프로젝트 루트에서 실행한다. `alice-minimax-v1`은 자신의 고유 ID로 바꾼다.

```powershell
npm run model:new -- --id alice-minimax-v1 --author Alice
```

이 명령은 `models/alice-minimax-v1.mjs`를 만들고 `models/registry.json` 배열에 항목을 추가한다. 생성 도구의 ID는 영문 소문자/숫자로 시작하며 영문 소문자·숫자·하이픈으로 된 1~80자다. 생성된 코드는 첫 합법수를 선택하는 **연결 확인용 골격**이므로 자신의 알고리즘으로 교체한다.

이미 구현한 모델도 새 `.mjs` 파일로 옮겨 같은 계약을 내보내면 된다. registry의 항목 예시는 다음과 같다. 기존 배열 전체를 아래 한 항목으로 교체하지 않는다.

```json
{
  "id": "alice-minimax-v1",
  "name": "Alice minimax",
  "version": "1.0.0",
  "protocol": "js-v1",
  "ruleset": "twelve-janggi-strict-v2",
  "entry": "./alice-minimax-v1.mjs",
  "files": [],
  "config": { "depth": 4 },
  "author": "Alice"
}
```

| 필드 | 작성 방법 |
| --- | --- |
| `id` | 실행 artifact 버전의 고유 ID. 코드/config 변경 시 새 ID |
| `name` | 화면의 모델 이름 |
| `version` | 비어 있지 않은 버전 문자열. 예: `1.0.0` |
| `protocol` / `ruleset` | 현재는 위 예시 값 사용 |
| `entry` | `models/` 기준 진입 파일 상대 경로 |
| `files` | 진입 파일 외 실제 읽기/import하는 helper·가중치의 상대 경로 목록 |
| `config` | 모델 요청으로 전달할 JSON 객체 |
| `author` | registry의 제출자 메타데이터; 모델 소개 화면에는 이름 입력 항목이 없음 |

예를 들어 실제로 `models/alice-eval.mjs`, `models/alice-weights.json`을 추가했다면 `files`를 `["./alice-eval.mjs", "./alice-weights.json"]`로 바꾼다. helper가 다시 읽는 파일도 포함한다. 존재하지 않는 예시 경로를 그대로 등록하지 않는다. 절대 경로·models 밖 파일·밖으로 연결되는 symlink는 허용하지 않는다.

모델의 상대 파일 경로는 `new URL('./alice-weights.json', import.meta.url)`처럼 모델 파일 기준으로 계산한다. 현재 실행 계약은 선언한 로컬 파일과 허용 범위의 Node 내장 기능을 기준으로 한다. 임의 npm 패키지나 외부 프로그램이 자동으로 제공되지는 않는다.

## 3. `think(request)` 구현

다음은 계약을 보여주는 최소 예제다. 강한 모델의 구현 예제가 아니며 `legalActions[0]` 선택 부분을 자신의 탐색기로 바꾼다.

```javascript
// models/alice-minimax-v1.mjs
export function think({ state, legalActions, budgetMs, seed, config }) {
  if (!legalActions.length) throw new Error('No legal actions');
  // state와 legalActions는 읽기 전용으로 취급한다.
  const action = legalActions[0];
  return { action, info: { nodes: 1, completedDepth: 0 } };
}
```

동기 함수와 async 함수 모두 가능하다. default export가 아니라 **이름이 `think`인 named export**가 필요하다.

| 요청 필드 | 의미 |
| --- | --- |
| `protocol` | `js-v1` |
| `requestId` | 요청 식별자. 응답 포장은 실행기가 처리 |
| `ruleset` | `twelve-janggi-strict-v2` |
| `state` | 현재 국면과 반복 이력 |
| `legalActions` | 현재 국면의 합법수 배열 |
| `budgetMs` | 현재 웹 설정은 `60000`; CLI에서는 지정값 |
| `seed` | 재현용 uint32 난수 seed |
| `config` | registry에 등록한 모델 설정 객체 |

반환 형식은 아래 둘 중 하나다. 숫자는 화면 좌표가 아닌 내부 인덱스다. 좌표 예시는 형식 설명이며 해당 국면에서 실제 합법인지는 `legalActions`로 확인한다.

```javascript
// 보드 기물 이동
return { action: { from: 5, to: 6 } };
// 포로 투입
return { action: { drop: 'pawn', to: 1 } };
```

이동은 `from/to`, 투입은 `drop/to`만 사용한다. `drop`은 `pawn`, `rook`, `bishop`이다. 왕·후는 투입할 수 없다. 서버가 합법수를 다시 검사하며 잘못된 수를 다른 수로 대신 두지 않는다.

선택적인 `info`에는 음수가 아닌 유한 숫자 `nodes`, `completedDepth`, `searchMs`를 넣을 수 있다. 다른 메타데이터는 전달되지 않는다. `searchMs`는 모델의 자기 보고이며 공식 착수시간은 실행기가 잰 값이다. 종국 상태에는 모델을 호출하지 않는다.

### 좌표와 상태

내부 보드는 **가로 4 × 세로 3**이고 `index = y * 4 + x`다.

```text
내부 좌표                 화면 배치(회전 후 가로 3 × 세로 4)
 0   1   2   3             3   7  11
 4   5   6   7             2   6  10
 8   9  10  11             1   5   9
                           0   4   8
```

청은 `side:0`, 홍은 `side:1`이다. 청의 앞은 내부 **+x**, 홍은 **-x**다. 화면에서는 청이 아래다. 항상 청부터 시작한다고 가정하면 안 된다.

| 상태 필드 | 내용 |
| --- | --- |
| `board` | 길이 12 배열. 각 칸은 `null` 또는 `{side, kind}` |
| `kind` | `king`(왕), `rook`(장), `bishop`(상), `pawn`(자), `hen`(후) |
| `hands` | `[청 포로 배열, 홍 포로 배열]`; 원소는 `rook/bishop/pawn` 문자열 |
| `turn` | 현재 차례 `0` 또는 `1` |
| `ply` | 진행한 착수 수 |
| `winner` | 진행 중 `null`, 청 승 `0`, 홍 승 `1`, 무승부 `'draw'` |
| `termination`, `reason` | 종국 종류와 사유 |
| `positions` | 초기 국면부터의 반복 판정용 키 배열 |
| `ruleset`, `last`, `log` | 규칙 식별자, 최근 수, 로그 |

### 엔진 재사용과 탐색 이력

직접 규칙을 다시 구현하기보다 기존 엔진을 사용한다.

```javascript
import { applyAction, legalActions, positionKey } from '../src/engine.js';

// think 안에서 탐색할 때:
const next = applyAction(state, candidate, false);
// next.winner를 먼저 확인하고, 진행 중일 때만 다음 합법수를 탐색한다.
```

`applyAction(state, action, false)`는 원본을 바꾸지 않고 다음 상태를 만들며 `positions`도 보존한다. 합법수 생성·장군·승패·승격·반복 처리를 엔진과 동일하게 유지한다. 입력 보드/포로/합법수 배열을 직접 변경하지 않는다.

**같은 보드라도 반복 이력이 다르면 상태의 가치가 다를 수 있다.** Transposition table에서 보드 키만 같다는 이유로 서로 다른 이력을 같은 정확값으로 처리하지 않는다. `positionKey`는 한 국면의 반복 비교 키이며 전체 이력을 대신하지 않는다. 이력을 보존하는 키/캐시 정책을 설계한다.

난수가 필요하면 제공된 seed를 사용한다. `Date.now()`나 매번 달라지는 seed를 쓰면 재현성이 깨진다. 게임 안에서는 모델 Worker를 재사용하므로 전역 캐시는 여러 수에 걸쳐 남을 수 있다. 다른 게임으로 넘길 상태는 두지 않는다. 대국마다 새 실행 환경이 만들어진다.

### 60초 예산

반환 직전까지 60초를 전부 사용하지 않는다. 모듈 로드·스케줄링·통신 비용과 서버 deadline을 위한 여유가 필요하다. 반복 심화라면 완료한 깊이의 최선수를 보관하고 자체 탐색 시간 한도에서 반환한다. 모델이 보고한 시간으로 deadline을 연장할 수 없다.

웹 실행의 모델 로드 제한은 10초이며 부모 watchdog은 약 11초다. 전체 턴 deadline도 적용한다. 무한 루프/미반환은 시간 초과로 종료된다. 큰 가중치나 초기화가 필요하면 실제 웹 실행에서도 로드/응답을 검증한다.

## 4. 버전과 실행 경계

코드·helper·가중치·config가 바뀌면 `alice-minimax-v2`처럼 **새 ID와 version**을 추가한다. 과거 파일/registry 항목을 덮어쓰거나 과거 기보를 새 코드의 결과로 해석하지 않는다.

- `alice-minimax`처럼 끝의 `-v숫자`를 뺀 값이 모델 정체성이다.
- registry ID는 불변 artifact 버전 식별자다. 서버는 모델 정체성과 실행 버전을 나눠 저장한다.
- manifest/파일 해시와 규칙·실행기·lockfile·Node/OS 정보를 기록한다.
- artifact가 같고 실행기/runtime만 바뀌면 해시 접미사의 새 실행 ID가 생길 수 있다. 웹의 선택 ID와 registry ID가 달라질 수 있으므로 실제 실행 버전을 기록한다.
- registry는 앱 시작 시 읽는다. 파일/등록 변경 후 정상 재시작한다.

웹 모델은 API/DB 심판과 분리된 Node supervisor + Worker에서 계산한다. 선언 파일/엔진 등의 읽기만 제공하고 비밀 환경변수·게스트 세션·DB 경로를 모델 입력에 넣지 않는다. Worker heap 제한은 128MiB다.

이는 **검토한 팀 코드용 실행 경계**다. 동일 Windows 계정에서 실행하며 별도 OS 계정·Job Object·전체 CPU/메모리 강제 격리를 구성한 것은 아니다. 악성 코드의 안전 실행을 보장하지 않는다. CLI 평가는 신뢰된 로컬 실행이므로 웹과 같은 접근 제한이 있다고 가정하지 않는다.

## 5. 검증하고 대전하기

모델 파일·config를 완성한 후 다음 순서로 확인한다. 아래 `alice-minimax-v1`은 자신의 registry ID다. 명령 예시는 절차 안내이며 해당 이름의 모델이 미리 등록되어 있다는 뜻은 아니다.

```powershell
npm run setup
npm test

# 연결·응답·기보 검증용 4국
npm run evaluate -- --a alice-minimax-v1 --b greedy-v1 --games 4 --concurrency 2 --opening-plies 0 --move-ms 60000 --max-plies 256

# 최소 비교 규모 100국
npm run evaluate -- --a alice-minimax-v1 --b greedy-v1 --games 100 --concurrency 2 --opening-plies 0 --move-ms 60000 --max-plies 256 --seed 20261031

npm start
```

전체 `npm test`에는 3000 포트 재시작 검증이 포함되므로 앱이 종료된 상태에서 실행한다. 4국은 연결 검증이며 성능 판단 표본이 아니다. CLI의 기본 임의 오프닝은 4수이므로 **첫 수부터 모델이 두려면 `--opening-plies 0`을 반드시 넣는다.** 색상/선공 균등 비교를 위해 대국 수는 4의 배수로 맞춘다.

앱을 시작한 후 다음을 확인한다.

1. 모델 대전의 A/B 선택 목록에 새 모델 이름이 표시된다.
2. 모델 소개에서 이름을 선택하고 모델 특징을 작성한다. 소개는 공유되며 실행 코드와 별도로 저장된다.
3. 상대를 선택하고 **100국 추가 실행**을 요청한다.
4. 조합 기록의 승무패·평균 착수시간·개별 기보·시간·종국 이유를 확인한다. 플레이어 vs AI에서도 새 모델을 선택할 수 있다.

웹은 청이 첫 수를 두고, 매 판 A/B의 진영을 교대해 각각 청 50국과 홍 50국을 배정한다. CLI에서도 청이 선공이다. 첫 수부터 웹과 같은 배치를 사용하려면 `--opening-plies 0`으로 실행한다.

### 결과 파일과 재생

`npm run evaluate`는 headless 평가 후 기보를 전수 검증한다. 출력한 실제 run ID의 폴더를 사용한다.

| 파일 | 내용 |
| --- | --- |
| `artifacts/<run-id>/config.json` | 모델/해시·seed·규칙·실행 조건 |
| `games.jsonl` | 각 대국·수·응답 시간·실패 시도 |
| `summary.json` | 승무패·시간 분포·종국 통계 |
| `report.txt` | 읽기용 보고서 |

```powershell
npm run replay:verify -- --run artifacts/실제-run-id
npm run dev
```

CLI 기보는 `http://127.0.0.1:5173/experiments?run=실제-run-id`에서 확인한다. `--run` 재검증은 실행 조건·스케줄·기보·통계를 함께 확인한다. `--input games.jsonl`만 검증하는 것은 전체 실행 검증을 대신하지 않는다. CLI 원본은 보존하며 웹의 수동 모델 조합에 자동 합산하지 않는다.

### 결과 해석과 오류

웹은 동일 artifact 조합을 선택 순서에 관계없이 누적하고 각 배치의 실제 실행 버전/조건을 보존한다. 100국을 반복했어도 결정론적 모델에 같은 입력을 다시 준 결과는 독립 표본이 아니다. 선공·진영·초기 차례가 바뀌면 결정론적 모델도 다른 수순과 대국 길이를 낼 수 있다.

승률은 `W/N`, 득점률은 `(W+D/2)/N`이다. 웹에는 승무패·승률·평균 착수시간을 표시하며 연구용 원본 통계는 별도다. 표본 성과를 최적성 증명으로 해석하지 않는다. 자동 챔피언 승격/신뢰구간 분석은 아직 제공하지 않는다.

| 상황 | 처리/확인 |
| --- | --- |
| 모델 예외·불법수·응답 규격 오류·시간 초과 | 해당 모델 패배. 원인 수정 후 새 버전으로 재평가 |
| 호스트/DB 장애 | 인프라 미완료/재시도로 구분. 수동 작업은 최대 3회 복구하며 실패 시도도 보존 |
| 목록에 모델이 없음 | registry ID/형식 확인 후 앱 재시작 |
| 불변 버전 변경 오류 | 기존 ID의 코드/config를 바꿨는지 확인. 과거 버전 복원 후 새 ID 추가 |
| 파일 접근 거부 | helper/가중치의 `files` 누락·상대 경로 확인 |
| `model-error` | `think` named export·import·실행 예외 확인 |
| 불법 이동/투입 | 내부 인덱스·차례·자기 왕 안전·포로 투입 제한·반복 이력 확인 |
| CLI는 성공하고 웹은 실패 | 웹의 파일 접근·로드/메모리/턴 시간 제한도 따로 확인 |

모든 게스트가 웹 조합 기록을 삭제할 수 있다. 삭제는 공개 조회와 진행 작업을 중단하는 논리 삭제이며 내부 원본은 보존한다. 다시 실행하면 새 조합 기록으로 시작한다.

## 제출 시 함께 전달할 내용

- 모델 이름·ID/version·파일 및 registry 변경 사항.
- 알고리즘·평가 함수·탐색 한도·config·helper/가중치와 출처/해시.
- seed/게임별 초기화와 반복 이력/캐시 처리 방식.
- 상대의 정확한 실행 버전·run ID·대국 조건·승무패·시간·실패 원인·알려진 한계.

팀 검토를 거쳐 코드와 registry를 반영한다. Git/PR을 사용하는 경우 이 파일들을 함께 제출하고 `.env`·DB·세션·개인 키는 포함하지 않는다. 기존 모델·기보·사용자 기록을 교체하지 않는다.
