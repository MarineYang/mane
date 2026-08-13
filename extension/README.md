# extension — 크롬 확장 (MVP 핵심)

웹플레이어 위에 **일본어 원자막 + 한국어 번역** 2줄 오버레이, 표현 하이라이트, 탭→저장.

## 사이트 어댑터 구조

확장 코드의 대부분은 사이트와 무관한 **공통 레이어**이고, 사이트별로 갈리는 것은 **cue 취득 방식**과 **재생 시각 접근**뿐이다. 이 둘만 `SubtitleSource` 뒤로 분리한다.

```
SubtitleSource (interface)
  ├─ YouTubeAdapter   ← youtube.com/watch + /shorts   (PoC 완료)
  └─ NetflixAdapter   ← netflix.com/watch             (미구현)
```

| 구분 | 내용 |
|---|---|
| 공통(재사용) | 오버레이 렌더러, 번역 클라이언트, NLP 하이라이트, 뜻풀이 툴팁, 표현 저장/동기화 |
| 어댑터별 | cue 취득, 플레이어 `currentTime`, 오버레이 부착 지점, SPA 전환 감지 |

## 디렉토리

| 경로 | 상태 | 설명 |
|---|---|---|
| [`poc/`](poc/) | **동작함** | 유튜브 이중자막 PoC. 순수 JS, 빌드 없이 바로 로드해 테스트 가능 |
| `src/` | 미구현 | 프로덕션 확장 (TypeScript · MV3) |

> **먼저 [`poc/README.md`](poc/README.md) 를 보고 로컬에서 동작을 확인할 것.** 넷플릭스는 유료 구독·DRM·플레이어 통제 때문에 초기 난이도가 높아, 파이프라인 전체를 유튜브에서 먼저 검증한 뒤 `NetflixAdapter`만 갈아끼운다. ([ADR 0002](../docs/adr/0002-site-adapter-and-youtube-first.md))

## 난제

SPA 재초기화 · 배속/seek 싱크 재보정 · 플레이어 오버라이트 대응 · (넷플릭스) 영상 DRM은 자막 텍스트와 무관

> 상세는 [`../docs/architecture.md`](../docs/architecture.md) §1.
