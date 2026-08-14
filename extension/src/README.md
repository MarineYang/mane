# extension/src — 크롬 확장 (MV3, 빌드 없음)

PoC(`../poc/`)에서 검증한 cue 취득·싱크 로직을 그대로 이어받고, 그 위에
**사이트 어댑터 구조 · 백엔드 번역 · 단어 하이라이트/툴팁 · 표현 저장 · 쉐도잉**을 얹은 실제 확장.

**빌드 도구 없음.** 순수 JS + MV3라 `chrome://extensions` 에서 이 폴더를 그대로 로드하면 된다.
(npm·번들러·TypeScript 없음 — 의존성 0)

## 로드 방법

1. 백엔드를 먼저 띄운다. API 키 없이도 스텁으로 전부 동작한다.
   ```bash
   cd backend && go run ./cmd/api      # http://localhost:8080
   ```
2. Chrome 주소창에 `chrome://extensions` → 우측 상단 **개발자 모드** ON
3. **압축해제된 확장 프로그램을 로드** → 이 폴더(`extension/src`) 선택
4. 툴바의 확장 아이콘을 눌러 **백엔드 주소**와 **JLPT 레벨**을 확인/저장
   (기본값 `http://localhost:8080` / `N4`). **연결 확인** 버튼으로 `/healthz` 응답을 볼 수 있다.
5. **일본어 자막이 있는 유튜브 영상**을 연다.

> 기본값이 아닌 백엔드 주소를 저장하면 저장 시점에 해당 오리진 접근 권한을 묻는다(허용해야 동작).
> 팝업에서 권한 창이 뜨면 팝업이 닫힐 수 있으니, 그 경우 `chrome://extensions` → 세부정보 → 확장 옵션에서 다시 저장.

## 테스트 절차

| 확인 항목 | 방법 |
|---|---|
| 이중자막 | 영상 하단에 일본어(흰색, 큼) + 한국어(노란색, 작음) 2줄 |
| 백엔드 번역 | 콘솔에 `번역 완료 — N줄`. `ANTHROPIC_API_KEY` 없으면 한국어 줄이 `[ko stub] 원문` |
| 싱크 | 배속 변경 · seek · 일시정지 후에도 자막이 어긋나지 않음 |
| SPA 전환 | 다른 영상으로 이동 시 이전 자막이 남지 않고 새로 로드 |
| 전체화면 | 전체화면에서도 오버레이·툴팁이 따라감 |
| 단어 하이라이트 | 일본어 줄의 단어에 hover 하면 반응, 레벨 대상 단어는 파란 밑줄 |
| 툴팁 | 단어 클릭 → surface/읽기/JLPT/뜻 + `저장` 버튼 |
| 표현 저장 | `저장` → "저장했습니다 ✓". `curl localhost:8080/v1/expressions` 로 확인 |
| 문장 저장 | 대사 오른쪽 `☆` → `★`. 현재 자막 전체와 번역·영상 시각 저장 |
| 보관함 | 날짜 이전/다음·달력·오늘 이동, `전체/단어/문장` 필터로 조회 |
| 문장 반복 | `쉐도잉` 탭 → 세트 만들기 → `원음 듣기`/`구간 반복` |
| 블라인드 발화 | 원음 반복 후 자막을 숨기고 직접 말한 다음 원음 확인 |
| 자기평가 | 어려움/비슷함/자연스러움으로 복습 간격 결정 |
| 복습 | 평가한 문장이 1일/3일/7일 뒤 `오늘의 복습`에 노출 |
| 백엔드 다운 시 | 백엔드를 끄고 새로고침 → 일본어 줄은 계속 나오고 콘솔에 경고만 |

- **Alt + J** (macOS 는 **Option + J**) : 이중자막 표시 토글
- 진행 상황은 DevTools 콘솔에 `[langflix-jp]` 로 찍힌다.
- 서비스 워커 로그는 `chrome://extensions` → 해당 확장의 **서비스 워커** 링크에서 본다.

## 파일 구조

```
manifest.json                  MV3. content script 로드 순서가 곧 의존 순서다
background.js                  서비스 워커 — 백엔드 호출 전담(translate/analyze/save)
common/
  subtitle-source.js           SubtitleSource 계약 문서 + 어댑터 레지스트리 + 이진 탐색
  api.js                       백엔드 클라이언트(서비스 워커 메시지 래퍼). 실패를 값으로 반환
  tooltip.js                   단어 툴팁 + 저장 버튼
  overlay.js                   오버레이 렌더러(2줄, 단어 span, 재부착)
  shadowing-practice.js        듣기·오버랩·블라인드 발화·자기평가·복습 UI
  controller.js                진입점 — 어댑터 선택 → cue → 번역 → 분석 → 렌더 루프
adapters/
  youtube.js                   YouTubeAdapter (격리 환경 절반: 배선 + 플레이어 핸들)
  youtube-injected.js          YouTubeAdapter (페이지 컨텍스트 절반: cue 취득)
  netflix.js                   NetflixAdapter — 플레이어·메시지·패널 배선
  netflix-injected.js          Netflix TTML/WebVTT 응답 포착·파싱
ui/
  overlay.css                  오버레이·단어·툴팁 스타일
  options.html/.css/.js        설정(팝업 겸 옵션): 백엔드 주소, JLPT 레벨
```

## 사이트 어댑터 구조

사이트마다 다른 것은 **딱 둘**이다 — ① 자막 cue 를 어디서 얻는가, ② 재생 시각/오버레이
부착 지점을 어떻게 잡는가. 이 둘만 `SubtitleSource` 뒤로 분리했고 나머지(오버레이·번역·
하이라이트·툴팁·저장)는 전부 공통이다.

```
SubtitleSource (계약)
  ├─ YouTubeAdapter   ← youtube.com  (watch + shorts, 동작)
  └─ NetflixAdapter   ← netflix.com/watch  (구현, 실계정 검증 필요)
```

### 계약 (전문은 `common/subtitle-source.js` 상단)

```js
Cue         = { start:number, end:number, text:string }   // 초 단위, start 오름차순
ContentMeta = { platform:string, contentId:string, title:string }

SubtitleSource {
  platform                       // 'youtube' | 'netflix' — 백엔드 source.platform 과 동일
  matches(url: URL): boolean     // 레지스트리가 이것만 보고 어댑터를 고른다
  attach(handlers): void         // cue 취득 + SPA 감시 시작 (멱등)
  detach(): void
  getCurrentTime(): number|null  // 플레이어 현재 재생 시각(초)
  getMountPoint(): HTMLElement|null  // 오버레이를 붙일 컨테이너
  getContentMeta(): ContentMeta
}

handlers {
  onCues({ contentId, cues, meta })  // 일본어 cue 확보 완료(영상 바뀌면 재호출)
  onUnavailable(info)                // 일본어 자막 없음
  onError(err)                       // 취득 실패(복구 가능)
  onNavigate()                       // SPA 전환 → 공통 레이어가 teardown
}
```

**새 사이트 추가 = 어댑터 파일 1개 + `LFJP.registerAdapter(adapter)` 한 줄 + manifest `matches` 에 도메인 추가.**
공통 레이어는 손대지 않는다.

## 백엔드 연동

`backend/README.md` 의 계약을 그대로 따른다. 모든 호출은 서비스 워커가 한다 —
content script 의 fetch 는 확장 host_permissions 가 아니라 페이지 오리진의 CORS 규칙을
따르기 때문에, 배포 시 `ALLOWED_ORIGINS` 를 좁혀도 확장이 계속 동작하게 하려는 것.

| 시점 | 호출 |
|---|---|
| cue 로드 직후 | `POST /v1/translate` — `{source_lang:"ja", target_lang:"ko", texts:[...]}`, 500개씩 청크 |
| 화면에 뜰 cue + 다음 3개 | `POST /v1/nlp/analyze` — `{texts:[...], level:"N4"}`, 80ms 디바운스 배치 |
| 단어·문장 저장 | `POST /v1/expressions` — `{kind, surface, reading, gloss, jlpt, context, source:{platform, content_id, title, time_sec}}` |
| 날짜별 보관함 | `GET /v1/expressions?from=<RFC3339>&to=<RFC3339>&kind=word|sentence` |

- 토큰의 `start`/`end` 는 **UTF-16 코드 유닛 오프셋**이라 `text.slice(start, end)` 로 바로 자른다. 클라이언트에서 재토큰화하지 않는다.
- `highlight: true` 인 토큰만 강조한다(레벨 판단은 백엔드 몫).
- `reading`/`jlpt`/`gloss` 는 NLP 스텁 모드에서 비어 온다 → 해당 행을 그리지 않고 "사전 정보 없음"으로 표시.

**연결 실패는 자막을 죽이지 않는다.** 번역 실패 → 한국어 줄만 비고, 분석 실패 → 하이라이트만
없다. 두 경우 모두 콘솔에 경고 1회.

## PoC 대비 달라진 점

| 항목 | PoC | 여기 |
|---|---|---|
| 한국어 라인 | 유튜브 자동 번역(`tlang`) | 백엔드 `POST /v1/translate` |
| 단어 단위 | 없음 | `/v1/nlp/analyze` 토큰 → 클릭 가능한 span |
| 툴팁·저장 | 없음 | 툴팁 + `POST /v1/expressions` |
| 구조 | 파일 2개 | SubtitleSource + 어댑터 등록제 |
| 설정 | 없음 | 팝업/옵션(백엔드 주소, JLPT 레벨) |

## 아직 안 된 것

- **Netflix 실계정 E2E** — 응답 형식·전체화면·에피소드 전환 검증 필요.
- **인증** — 백엔드가 `X-User-Id` 없으면 `dev-user` 로 처리. 확장은 헤더를 보내지 않는다.
- **마이크·전문 발음 채점** — 보류. 활성 Manifest는 마이크 코드를 로드하지 않는다.
- **프로덕션 DB** — 로컬 `DATA_FILE` 저장은 지원하지만 PostgreSQL은 미구현.

이전에 만든 마이크 실험 코드는 `experimental/shadowing-microphone.js`에 격리되어
있으며 Manifest에서 로드하지 않는다.
