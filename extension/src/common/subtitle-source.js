/**
 * SubtitleSource — 사이트별로 갈리는 것만 담는 계약 (architecture.md §1-1).
 *
 * 확장 코드의 대부분(오버레이 렌더러, 번역 클라이언트, NLP 하이라이트, 툴팁,
 * 표현 저장)은 사이트와 무관하다. 사이트마다 다른 것은 딱 둘뿐이다:
 *   1) 자막 cue 를 어디서 얻는가
 *   2) 플레이어의 현재 재생 시각 / 오버레이를 붙일 지점을 어떻게 잡는가
 * 이 파일은 그 둘만 인터페이스로 고정한다.
 *
 * ── 계약 ────────────────────────────────────────────────────────────────
 *
 * @typedef {{ start:number, end:number, text:string }} Cue
 *          start/end 는 초 단위 재생 시각. 배열은 start 오름차순 정렬이어야 한다
 *          (공통 레이어가 이진 탐색으로 현재 cue 를 찾기 때문).
 *
 * @typedef {{ platform:string, contentId:string, title:string }} ContentMeta
 *          표현 저장 시 source 로 그대로 들어간다. platform 은 'youtube' | 'netflix'.
 *
 * @typedef {Object} SubtitleSourceHandlers
 * @property {(payload:{contentId:string, cues:Cue[], meta?:Object}) => void} onCues
 *           일본어 cue 확보 완료. 같은 페이지에서 영상이 바뀌면 다시 호출될 수 있다.
 * @property {(info:Object) => void} onUnavailable  이 콘텐츠에는 일본어 자막이 없다.
 * @property {(err:Object) => void}  onError        취득 실패(복구 가능).
 * @property {() => void}            onNavigate     SPA 전환 — 공통 레이어가 teardown 한다.
 *
 * @typedef {Object} SubtitleSource
 * @property {string} platform
 *           'youtube' | 'netflix'. 백엔드 source.platform 과 동일한 값.
 * @property {(url:URL) => boolean} matches
 *           이 어댑터가 담당할 URL인지. 레지스트리가 이것만 보고 고른다.
 * @property {(handlers:SubtitleSourceHandlers) => void} attach
 *           cue 취득 시작 + SPA 전환 감시 시작. 멱등이어야 한다.
 * @property {() => void} detach
 *           리스너/타이머 정리. attach 로 만든 것만 걷어낸다.
 * @property {() => (number|null)} getCurrentTime
 *           플레이어의 현재 재생 시각(초). 플레이어가 아직 없으면 null.
 *           배속·seek·버퍼링과 무관하게 "지금 이 순간의 진실"이어야 한다.
 * @property {() => (HTMLElement|null)} getMountPoint
 *           오버레이를 붙일 컨테이너(전체화면에서도 따라가는 요소).
 *           position 이 static 이면 공통 레이어가 relative 로 올린다.
 * @property {() => ContentMeta} getContentMeta
 * @property {(() => (HTMLMediaElement|null))=} getMediaElement
 *           쉐도잉 구간 재생용 원본 미디어. 지원하지 않으면 생략 가능.
 *
 * ── 새 사이트 추가 ──────────────────────────────────────────────────────
 * 어댑터 파일 하나 만들고 `LFJP.registerAdapter(adapter)` 한 줄, manifest 의
 * matches 에 도메인 추가. 공통 레이어는 손대지 않는다.
 */
'use strict';

var LFJP = window.LFJP || (window.LFJP = {});

LFJP.CHANNEL = 'LANGFLIX_JP';
LFJP.log = (...a) => console.log('%c[langflix-jp]', 'color:#4ea1ff', ...a);
LFJP.warn = (...a) => console.warn('[langflix-jp]', ...a);

LFJP.adapters = [];

/**
 * 문장을 형태소 토큰 단위 <span> 으로 쪼개 DocumentFragment 로 돌려준다.
 *
 * 오버레이와 트랜스크립트 패널이 같은 규칙으로 그려야 해서 여기 둔다. 특히 오프셋
 * 해석은 한 곳에만 있어야 한다 — start/end 는 UTF-16 코드 유닛이라 slice 로 바로
 * 자르며, 절대 클라이언트에서 다시 토큰화하지 않는다.
 *
 * 토큰 사이의 빈 구간(조사·기호 등 분석에서 빠진 부분)도 원문 그대로 살린다.
 *
 * @param {string} text
 * @param {Array} tokens
 * @param {(token:Object, span:HTMLElement) => void} onWordClick
 */
LFJP.renderTokens = function (text, tokens, onWordClick) {
  const frag = document.createDocumentFragment();
  let cursor = 0;

  for (const token of tokens || []) {
    const start = Number(token.start);
    const end = Number(token.end);
    if (!(end > start) || start < cursor || end > text.length) continue;

    if (start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, start)));

    const span = document.createElement('span');
    span.className = 'lfjp-word' + (token.highlight ? ' lfjp-hl' : '');
    span.textContent = text.slice(start, end);
    span.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (onWordClick) onWordClick(token, span);
    });
    frag.appendChild(span);
    cursor = end;
  }

  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  return frag;
};

/** @param {SubtitleSource} adapter */
LFJP.registerAdapter = function (adapter) {
  LFJP.adapters.push(adapter);
};

/** @returns {SubtitleSource|null} */
LFJP.pickAdapter = function (url) {
  return LFJP.adapters.find((a) => {
    try {
      return a.matches(url);
    } catch (_) {
      return false;
    }
  }) || null;
};

/**
 * cue 는 start 오름차순이므로 이진 탐색으로 현재 cue 를 찾는다.
 * @param {Array<{start:number,end:number}>} cues
 */
LFJP.findCueIndex = function (cues, t) {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cue = cues[mid];
    if (t < cue.start) hi = mid - 1;
    else if (t >= cue.end) lo = mid + 1;
    else return mid;
  }
  return -1;
};
