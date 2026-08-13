# langflix-jp

**유튜브·Netflix 한·일 이중자막 + 반복·복습으로 이어지는 쉐도잉 학습 플랫폼**

좋아하는 한·일 영상에서 연습할 문장을 고르고, 원음을 반복해 들은 뒤 직접 말하고
피드백을 받는 Chrome 확장과 Go 백엔드의 동작 가능한 MVP다.

> 상세 설계는 [`docs/architecture.md`](docs/architecture.md) 참고.

## 확정 방향
- **소스**: YouTube 우선, Netflix는 어댑터 스텁
- **학습 방향**: 한국어 사용자→일본어, 일본어 사용자→한국어
- **스택**: 순수 JavaScript Chrome 확장 + Go/Gin 백엔드 + Python/FastAPI 일본어 NLP
- **MVP**: 이중자막, 표현 저장, 8문장 무마이크 쉐도잉, 자기평가, SRS 복습
- **보류**: 마이크 녹음·음성 인식·자동 발음 점수

## 학습 루프
이중자막 시청 → 문장 선택 → 원음 듣기 → 반복·오버랩 → 자막 없이 말하기 → 자기평가·복습

## 디렉토리
| 경로 | 역할 | 스택 |
|---|---|---|
| `extension/` | YouTube 이중자막·표현 저장·브라우저 쉐도잉 | JavaScript, MV3 |
| `app/` | 향후 모바일 앱 자리 | Flutter 예정 |
| `backend/` | 표현·번역·문장 선별·자기평가·복습 | Go/Gin |
| `nlp-service/` | 형태소·후리가나·JLPT·사전 | Python/FastAPI (Sudachi) |
| `infra/` | 로컬 실행(Postgres·Redis 등) | docker-compose |
| `docs/` | 아키텍처 설계안 · 결정 기록(ADR) | Markdown |

## 상태
- [x] langflix.io 조사 및 데이터 취득 방식 분석
- [x] 일본어 버전 아키텍처 설계안 (`docs/architecture.md`)
- [x] 크롬 확장 사이트 어댑터 구조 확정 + 유튜브 PoC 선행 결정 ([ADR 0002](docs/adr/0002-site-adapter-and-youtube-first.md))
- [x] **유튜브 이중자막 PoC** — 로컬 테스트 가능 ([`extension/poc/`](extension/poc/README.md))
- [x] 영상 전체에서 연습 문장 8개 자동 선별
- [x] 원음 듣기 + 구간 반복·오버랩 + 블라인드 발화
- [x] 어려움/익히는 중/자연스러움 자기평가 기반 복습
- [x] 쉐도잉 시도 저장 + 오늘의 복습
- [x] 일본어↔한국어 학습 방향 설정
- [x] Netflix TTML/WebVTT 자막 응답 어댑터 구현
- [x] `DATA_FILE` 기반 표현·쉐도잉 복습 영속 저장
- [ ] PoC 실제 브라우저 검증 (자막 취득·싱크·SPA 전환)
- [x] 백엔드 `/translate` 연동 (API 키가 없으면 스텁)
- [x] 일본어 NLP `/analyze` 연동
- [ ] 마이크·전문 발음 채점 재개 여부 결정
- [ ] 인증·프로덕션 PostgreSQL 영속성
- [ ] Netflix 실제 계정 환경 E2E 검증

## 지금 바로 테스트하기

```
chrome://extensions → 개발자 모드 ON → "압축해제된 확장 프로그램을 로드" → extension/src 선택
→ 일본어 또는 한국어 자막이 있는 유튜브 영상 재생
```
자세한 절차와 확인 항목은 [`extension/src/README.md`](extension/src/README.md).

영상 옆 패널의 **쉐도잉** 탭에서 `이 영상에서 8문장 연습`을 누르면 된다.

현재 활성 학습 흐름은 마이크 권한을 요청하지 않는다. 사용자가 직접 말한 느낌을
`어려웠어요 / 비슷하게 말했어요 / 자연스러웠어요`로 기록해 복습 간격을 정한다.
