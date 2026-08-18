# backend — API 서버

Go / Gin. 표현 저장·번역·NLP 프록시와 쉐도잉 문장 선별·자기평가·복습을 담당한다.

## 실행

```bash
cd backend
go run ./cmd/api          # http://localhost:8090
```

**설정 없이 바로 뜬다.** `ANTHROPIC_API_KEY`나 `NLP_SERVICE_URL`이 없으면 스텁 provider로 모든 엔드포인트를 정상 응답한다 — 확장을 API 키 없이도 끝까지 테스트할 수 있게 하려는 의도.

| 환경변수 | 기본값 | 없을 때 동작 |
|---|---|---|
| `PORT` | `8090` | |
| `ALLOWED_ORIGINS` | `*` | 개발용 전체 허용. 배포 전 반드시 지정 |
| `ANTHROPIC_API_KEY` | — | 번역 줄을 비워두는 스텁 사용. **단어 뜻도 나오지 않는다**(`dict=stub`) |
| `ANTHROPIC_MODEL` | `claude-opus-5` | 번역과 사전이 함께 쓴다 |
| `NLP_SERVICE_URL` | — | 형태소 분석 대신 **문자 종류 기반 분절**로 대체(읽기·JLPT·뜻풀이 없음) |
| `DATA_FILE` | — | 비어 있으면 인메모리. 경로를 주면 표현·복습 기록을 JSON으로 영속 저장 |
| `DICT_CACHE_FILE` | — | 비어 있으면 사전 캐시가 재시작 때 사라진다(같은 단어를 다시 청구). 경로를 주면 JSON으로 영속 저장 |

로컬 MVP에서 재시작 후에도 기록을 유지하려면 다음처럼 실행한다.

```bash
DATA_FILE=./data/langflix.json DICT_CACHE_FILE=./data/dict.json go run ./cmd/api
```

파일 저장은 임시 파일 작성·동기화·원자적 이름 변경 순서로 이루어지며 권한은 `0600`이다.

## API

베이스: `http://localhost:8090`. 사용자 식별은 아직 인증 미구현이라 `X-User-Id` 헤더(없으면 `dev-user`)로 대체한다.

### `GET /healthz`
```json
{ "status": "ok", "translator": "stub", "nlp": "stub", "dict": "stub", "dict_size": 0 }
```
`translator`/`nlp`/`dict` 값으로 실제 provider가 붙었는지 확인할 수 있다. `dict_size`는
지금까지 캐시에 쌓인 사전 항목 수다.

### `POST /v1/translate`
일본어 자막 cue를 한국어로. 배치 전용(최대 500개), 캐시 우선.

```json
// 요청 — source_lang/target_lang 생략 시 ja→ko
{ "source_lang": "ja", "target_lang": "ko", "texts": ["こんにちは"] }

// 응답
{ "translations": [
    { "source": "こんにちは", "target": "안녕하세요", "cached": false }
] }
```
순서는 입력과 1:1로 보존된다. `cached`로 캐시 적중을 확인할 수 있다.

### `POST /v1/nlp/analyze`
일본어 문장을 형태소로 분해. 하이라이트·툴팁·표현 저장의 전제.

```json
// 요청
{ "texts": ["日本語を勉強しています"], "level": "N4" }

// 응답
{ "results": [{
    "text": "日本語を勉強しています",
    "tokens": [
      { "surface": "日本語", "reading": "にほんご", "lemma": "日本語",
        "pos": "名詞", "jlpt": "N5", "gloss": "Japanese language",
        "start": 0, "end": 3, "highlight": false }
    ]
}] }
```

**`start`/`end`는 UTF-16 코드 유닛 오프셋이다.** 자바스크립트에서 `text.slice(start, end)`로 바로 자를 수 있다(바이트·룬 오프셋 아님).

**빈 값인 필드는 JSON에서 키 자체가 생략된다**(`omitempty`). 예를 들어 조사 `を` 토큰은 `reading`·`jlpt`·`gloss` 키가 아예 없다. 클라이언트는 `t.reading ?? ""` 처럼 안전하게 접근해야 한다.

`reading`·`jlpt`는 NLP 서비스가 붙어 있을 때만 채워진다. 스텁 모드에서는 `surface`와 오프셋만 반환된다. 형태소 분석기는 뜻을 모르므로 `gloss`는 항상 비어 있다 — 뜻은 아래 `/v1/dict/lookup`이 담당한다.

### `POST /v1/dict/lookup`

단어 하나의 사전 항목. **문장(`context`)을 함께 보내야** 동음이의어가 갈린다 —
「ぶん」은 그 줄이 무엇이냐에 따라 文/分/이름이 된다.

```json
// 요청 — 최대 20개
{
  "source_lang": "ja", "target_lang": "ko", "level": "N4",
  "items": [
    { "surface": "ぶん", "lemma": "ぶん", "reading": "", "pos": "名詞",
      "context": "ぶんちゃん…" }
  ]
}

// 응답 — 입력과 1:1 순서 보존
{
  "entries": [{
    "headword": "ぶん",
    "reading": "ぶん",
    "pos": "명사",
    "jlpt": "N3",
    "senses": [
      { "gloss": "글, 문장", "note": "文" },
      { "gloss": "몫, 분량", "note": "分" }
    ],
    "in_context": "이름(애칭)",
    "context_note": "여기서는 사람 이름 「ぶん」에 친근함을 나타내는 「ちゃん」이 붙은 형태입니다.",
    "examples": [{ "text": "この文は長い。", "translation": "이 문장은 길다." }],
    "cached": false
  }]
}
```

`senses`가 빈 항목은 뜻을 만들지 못했다는 뜻이다(스텁 모드 또는 뜻이 없는 기호).
클라이언트는 그때 `/v1/translate` 로 폴백한다.

**왜 데이터 파일이 아니라 모델인가.** 쓸 만한 공개 한일 사전이 없다 — JMdict는 영어·독일어·
러시아어는 있어도 한국어가 없고, KANJIDIC2는 한자의 한글 독음만 주며, 국립국어원 다국어
사전은 표제어가 한국어라 역방향 커버리지가 사실상 없다. 그래서 항목을 모델로 만들고
영구 캐시한다 — **캐시가 곧 사전이고, 쓸수록 쌓인다.** 같은 단어·같은 문장은 두 번 청구되지
않으며, `DICT_CACHE_FILE`을 지정하면 재시작해도 살아남는다.

### 표현 저장

```
POST   /v1/expressions      → 201, 생성된 객체
GET    /v1/expressions?limit=&offset=&kind=&from=&to=  → { expressions: [...], total: n }
DELETE /v1/expressions/:id  → 204 (없으면 404)
```

```json
// POST 본문 — surface만 필수, kind는 word(기본값) 또는 sentence
{
  "kind": "word", "surface": "勉強", "reading": "べんきょう", "gloss": "study", "jlpt": "N5",
  "context": "日本語を勉強しています",
  "source": { "platform": "youtube", "content_id": "abc123",
              "title": "...", "time_sec": 12.5 }
}
```

`from`은 포함, `to`는 미포함하는 RFC3339 시각이다. 클라이언트는 사용자의 현지 날짜 시작과 다음 날 시작을 UTC로 변환해 전달한다. `kind`가 없는 기존 저장 데이터는 `word`로 취급한다.
`source.platform`은 `youtube` 또는 `netflix` — 확장의 사이트 어댑터와 대응된다.

### 쉐도잉

`POST /v1/shadowing/set`은 자막 cue를 완전한 문장으로 합치고, 영상 전체에서 연습하기
좋은 문장을 시간대별로 고르게 선별한다.

`POST /v1/shadowing/attempts`는 `self_rating`을 `hard`, `good`, `easy` 중 하나로
받아 각각 1일, 3일, 7일 뒤 복습하도록 예약한다.

```
POST /v1/shadowing/attempts
GET  /v1/shadowing/reviews?due_before=<RFC3339>
POST /v1/shadowing/attempts/:id/review
```

마이크 기반 metrics 계약은 실험 호환을 위해 남아 있지만 활성 확장에서는 호출하지 않는다.

### 오류
모든 오류는 `{ "error": "<메시지>" }`. 400(잘못된 요청) · 404 · 502(업스트림 실패) · 500.

## 구조

```
cmd/api/            진입점 · provider 선택 · graceful shutdown
internal/config/    환경변수 로딩
internal/model/     Expression · Token · Analysis
internal/store/     ExpressionStore 인터페이스 + 인메모리 구현
internal/translate/ Translator 인터페이스 · Claude 구현 · 스텁 · 캐시 래퍼
internal/nlp/       Analyzer 인터페이스 · NLP 서비스 프록시 · 문자종류 분절 스텁
internal/dict/      Provider 인터페이스 · Claude 문맥 사전 · 스텁 · 캐시(+파일 영속)
internal/httpapi/   라우터 · CORS · 핸들러
```

번역기와 분석기 모두 인터페이스 뒤에 있어 공급자를 교체할 수 있다.

## 미구현 (설계상 다음 단계)

- **인증** — Google OAuth. 현재는 `X-User-Id` 헤더 대체
- **프로덕션 영속성** — 로컬 `DATA_FILE`은 구현됐지만 다중 인스턴스용 PostgreSQL은 미구현
- **전문 발음 채점 프록시** — 음소·고저악센트·받침
