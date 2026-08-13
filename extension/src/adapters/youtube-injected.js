/**
 * YouTubeAdapter 의 페이지 컨텍스트 절반.
 *
 * 여기서만 하는 일: 유튜브 player response 에서 자막 트랙 목록을 확보하고,
 * timedtext(json3)를 내려받아 cue 배열로 정규화해 content script 로 넘긴다.
 *
 * 페이지 컨텍스트여야 하는 이유 — timedtext 요청은 youtube.com 오리진 + 쿠키
 * 컨텍스트에서 나가야 하고, window.ytInitialPlayerResponse 는 격리 환경에서 안 보인다.
 *
 * PoC 와 다른 점: 번역 라인을 유튜브 자동 번역(tlang)으로 받지 않는다.
 * 번역은 백엔드 /v1/translate 가 담당하므로 여기서는 설정된 학습 언어 트랙만 가져온다.
 */
(() => {
  'use strict';

  // 이 파일은 두 경로로 들어올 수 있다 — manifest 의 MAIN world content script(빠름,
  // 최신 크로미움) 와 content script 가 심는 <script> 태그(구버전 대비). 먼저 도착한
  // 쪽만 실행한다. 둘 다 돌면 후킹이 이중으로 걸려 CUES 가 두 번 나간다.
  if (window.__lfjpInjected) return;
  window.__lfjpInjected = true;

  const CHANNEL = 'LANGFLIX_JP';
  let sourceLang = 'ja';
  const post = (type, payload) =>
    window.postMessage({ __langflix: CHANNEL, type, payload }, '*');

  /**
   * 진단 로그.
   *
   * 이 파일의 실패 경로는 대부분 조용한 return 이라, 아무 일도 일어나지 않으면
   * 어디서 멈췄는지 알 방법이 없었다. 각 분기를 소리내게 한다.
   */
  const debug = (msg, data) => post('DEBUG', { msg, data });

  /**
   * 같은 진단 메시지를 한 번만 낸다.
   *
   * 유튜브는 광고·하트비트·추천 카드까지 player 응답을 수십 번 흘린다. 그걸 전부
   * 찍으면 정작 중요한 한 줄이 스크롤 위로 밀려난다.
   */
  const seenDebug = new Set();
  const debugOnce = (key, msg, data) => {
    if (seenDebug.has(key)) return;
    seenDebug.add(key);
    debug(msg, data);
  };

  debug('주입 완료', { path: location.pathname });

  /** 같은 영상에 대해 중복 처리하지 않기 위한 가드 */
  let handledVideoId = null;

  window.addEventListener('message', (ev) => {
    const data = ev.data;
    if (ev.source !== window || !data || data.__langflix !== CHANNEL || data.type !== 'CONFIG') return;
    const next = data.payload && data.payload.sourceLang;
    if (next !== 'ja' && next !== 'ko') return;
    if (sourceLang === next) return;
    sourceLang = next;
    handledVideoId = null;
    handledTrackKey = null;
    debug('학습 언어 변경', { sourceLang });
    if (window.ytInitialPlayerResponse) handlePlayerResponse(window.ytInitialPlayerResponse);
  });

  /**
   * 실제로 영상을 보는 화면에서만 동작한다.
   *
   * 검색·홈·채널 화면도 카드 미리보기용으로 player response 를 미리 받아온다.
   * 거기엔 재생 중인 영상도, 오버레이를 붙일 플레이어도 없다. 유튜브는 SPA 라
   * 주입은 문서당 한 번뿐이므로, 주입 시점이 아니라 응답이 도착할 때마다 확인해야 한다.
   */
  function isWatchPage() {
    const path = location.pathname;
    return path === '/watch' || path.startsWith('/shorts/');
  }

  /**
   * 지금 주소창이 가리키는 영상 ID.
   *
   * 한 페이지에서 player response 는 여러 번 날아온다 — 광고, 다음 영상 미리보기,
   * 추천 카드… 이걸 걸러내지 않으면 광고의 자막 트랙(en-US 같은)을 보고
   * "일본어 자막이 없다" 고 잘못 판정한다.
   */
  function currentVideoId() {
    const path = location.pathname;
    if (path === '/watch') return new URLSearchParams(location.search).get('v');
    if (path.startsWith('/shorts/')) return path.slice(8).split('/')[0] || null;
    return null;
  }

  function getCaptionTracks(playerResponse) {
    return (
      playerResponse &&
      playerResponse.captions &&
      playerResponse.captions.playerCaptionsTracklistRenderer &&
      playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
    ) || null;
  }

  /** 정식 자막(non-ASR)을 자동생성 자막보다 우선한다. */
  function pickTrack(tracks, langPrefix) {
    if (!tracks) return null;
    const matched = tracks.filter((t) =>
      String(t.languageCode || '').toLowerCase().startsWith(langPrefix)
    );
    if (!matched.length) return null;
    return matched.find((t) => t.kind !== 'asr') || matched[0];
  }

  /**
   * @param {string} baseUrl captionTracks[].baseUrl
   * @returns {Promise<Array<{start:number,end:number,text:string}>>}
   */
  async function fetchCues(baseUrl) {
    const url = new URL(baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');

    const res = await fetch(url.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error('timedtext HTTP ' + res.status);

    // 유튜브는 자막 요청이 그 맥락에서 유효하지 않으면 200 에 빈 본문을 준다
    // (만료된 baseUrl, 미리보기 플레이어 등). res.json() 은 그걸 SyntaxError 로
    // 터뜨리므로 먼저 텍스트로 받는다.
    const raw = (await res.text()).trim();
    if (!raw) return [];

    let json;
    try {
      json = JSON.parse(raw);
    } catch (_) {
      // 본문이 비어 있지도 않은데 JSON 도 아니면(잘린 응답, 동의 페이지, 봇 차단
      // 등) 무엇이 왔는지 모르면 고칠 수 없다. 앞부분을 그대로 남긴다.
      const ct = res.headers.get('content-type') || '?';
      throw new Error(
        `timedtext 응답을 JSON 으로 읽지 못함 (content-type=${ct}, ${raw.length}바이트): ` +
          JSON.stringify(raw.slice(0, 120))
      );
    }

    return (json.events || [])
      .filter((e) => Array.isArray(e.segs))
      .map((e) => {
        const start = (e.tStartMs || 0) / 1000;
        const text = e.segs
          .map((s) => s.utf8 || '')
          .join('')
          .replace(/\s*\n\s*/g, ' ')
          .trim();
        return { start, end: start + (e.dDurationMs || 0) / 1000, text };
      })
      .filter((c) => c.text);
  }

  // ── 자막 본문 취득: 우리가 요청하지 않고 플레이어의 요청에 올라탄다 ──────────
  //
  // 유튜브는 timedtext 를 직접 부르면 서명된 baseUrl 에 쿠키·Referer 를 다 붙여도
  // 200 에 빈 본문을 준다(봇 차단). 반면 플레이어 자신의 요청은 정상적으로 받아온다 —
  // 우리가 재현할 수 없는 토큰이 붙기 때문. 그래서 요청을 만들지 말고 지나가는
  // 응답을 가로챈다. 사용자가 자막을 켜야 요청이 나간다는 전제가 붙는다.

  /** json3 · srv3(XML) · 구형 XML 을 모두 cue 배열로 정규화한다. */
  function parseTimedText(body) {
    const text = String(body || '').trim();
    if (!text) return [];

    if (text.startsWith('{')) {
      const json = JSON.parse(text);
      return (json.events || [])
        .filter((e) => Array.isArray(e.segs))
        .map((e) => {
          const start = (e.tStartMs || 0) / 1000;
          return {
            start,
            end: start + (e.dDurationMs || 0) / 1000,
            text: e.segs.map((s) => s.utf8 || '').join('').replace(/\s*\n\s*/g, ' ').trim()
          };
        })
        .filter((c) => c.text);
    }

    const doc = new DOMParser().parseFromString(text, 'text/xml');
    // srv3: <p t="ms" d="ms">, 구형: <text start="sec" dur="sec">
    const nodes = doc.querySelectorAll('p, text');
    const cues = [];
    nodes.forEach((n) => {
      const isP = n.tagName === 'p';
      const start = isP ? Number(n.getAttribute('t') || 0) / 1000 : Number(n.getAttribute('start') || 0);
      const dur = isP ? Number(n.getAttribute('d') || 0) / 1000 : Number(n.getAttribute('dur') || 0);
      const content = (n.textContent || '').replace(/\s*\n\s*/g, ' ').trim();
      if (content) cues.push({ start, end: start + dur, text: content });
    });
    return cues;
  }

  let handledTrackKey = null;

  /**
   * 플레이어에게 일본어 자막을 켜달라고 시킨다.
   *
   * 우리가 timedtext 를 직접 부르면 PO 토큰이 없어 빈 응답이 온다. 그런데 플레이어에게
   * 자막을 켜게 하면 플레이어가 자기 이름으로 — 토큰을 붙여서 — 요청을 내보내고,
   * 그 응답을 handleTimedText 가 가로챈다. 사용자가 CC 버튼을 누를 필요가 없어진다.
   *
   * 플레이어가 아직 준비되지 않았을 수 있어 잠깐 재시도한다.
   */
  function requestSourceCaptions(attempt) {
    const tries = attempt || 0;
    if (tries > 20) return;

    const player = document.querySelector('#movie_player');
    if (player && typeof player.loadModule === 'function') {
      try {
        // 자막이 이미 켜져 있으면 플레이어는 이미 자막을 받아버린 뒤다. 그 요청은
        // 우리 후킹이 걸리기 전에 지나갔을 수 있고, 같은 트랙을 다시 지정해봤자
        // 아무 요청도 나가지 않는다. 사용자가 CC 를 껐다 켜야만 되던 이유가 이것이다.
        // 모듈을 내렸다 올려 새 요청을 강제한다.
        try {
          player.unloadModule('captions');
        } catch (_) {
          /* 켜져 있지 않았으면 실패할 수 있다 — 무시 */
        }
        player.loadModule('captions');
        const list = player.getOption('captions', 'tracklist') || [];
        const selected = list.find((t) =>
          String(t.languageCode || '').toLowerCase().startsWith(sourceLang)
        );
        if (selected) {
          player.setOption('captions', 'track', { languageCode: selected.languageCode });
          debug('플레이어에 학습 언어 자막을 켜달라고 요청함', { lang: selected.languageCode });
          return;
        }
        debug('플레이어 트랙 목록에 일본어 없음', {
          tracks: list.map((t) => t.languageCode)
        });
      } catch (err) {
        debug('플레이어 자막 API 호출 실패', { error: String(err) });
      }
      return;
    }

    if (tries === 20) debug('플레이어 자막 API 를 찾지 못함 (재시도 종료)');
    setTimeout(() => requestSourceCaptions(tries + 1), 500);
  }

  function handleTimedText(url, body) {
    if (!isWatchPage()) return;
    try {
      const lang = new URL(url, location.origin).searchParams.get('lang') || '';
      debug('플레이어의 자막 응답을 포착', { lang, bytes: (body || '').length });

      if (!lang.toLowerCase().startsWith(sourceLang)) {
        debug('학습 언어 트랙이 아니라 건너뜀', { lang, sourceLang });
        return;
      }

      const videoId = currentVideoId();
      const key = videoId + '|' + lang;
      if (!videoId || key === handledTrackKey) return;

      const cues = parseTimedText(body);
      if (!cues.length) {
        debug('가로챈 자막이 비어 있음', { bytes: (body || '').length });
        return;
      }

      handledTrackKey = key;
      handledVideoId = videoId; // 직접 취득 경로가 중복으로 돌지 않도록
      post('CUES', {
        contentId: videoId,
        title: (document.title || '').replace(/ - YouTube$/, ''),
        cues,
        meta: { via: 'player-timedtext', lang }
      });
    } catch (err) {
      post('ERROR', { message: '자막 응답 해석 실패: ' + String(err) });
    }
  }

  async function handlePlayerResponse(playerResponse) {
    // 미리보기 응답은 handledVideoId 를 건드리기 전에 걸러야 한다. 먼저 잡아버리면
    // 검색 화면에서 스쳐 지나간 영상을 정작 열었을 때 "이미 처리함"으로 건너뛴다.
    if (!isWatchPage()) {
      debug('player 응답 무시 — 시청 페이지가 아님', { path: location.pathname });
      return;
    }

    const details = (playerResponse && playerResponse.videoDetails) || null;
    const videoId = details && details.videoId;
    // videoId 없는 응답(하트비트 등)과 이미 처리한 영상은 조용히 넘긴다 — 정상 동작이다.
    if (!videoId || videoId === handledVideoId) return;

    // 주소창의 영상과 다르면 광고나 미리보기다. handledVideoId 를 건드리기 전에 뺀다.
    const expected = currentVideoId();
    if (!expected || videoId !== expected) {
      debugOnce('mismatch:' + videoId, '광고/미리보기 응답 무시', { videoId, expected });
      return;
    }

    debug('player 응답 처리 시작', { videoId });
    handledVideoId = videoId;

    try {
      const tracks = getCaptionTracks(playerResponse);
      const selected = pickTrack(tracks, sourceLang);

      if (!selected) {
        post('NO_SOURCE_TRACK', {
          videoId,
          available: (tracks || []).map((t) => t.languageCode)
        });
        return;
      }

      const cues = await fetchCues(selected.baseUrl);
      if (!cues.length) {
        // 트랙은 있는데 본문이 비어 있다 = 유튜브가 우리 직접 요청을 막은 것(PO 토큰).
        // 플레이어에게 자막을 켜게 하면 토큰이 붙은 요청이 나가고 그걸 가로챈다.
        requestSourceCaptions();
        post('NEEDS_CC', { videoId, lang: selected.languageCode });
        return;
      }

      post('CUES', {
        contentId: videoId,
        title: details.title || '',
        cues,
        meta: { sourceLang, isAutoGenerated: selected.kind === 'asr' }
      });
    } catch (err) {
      handledVideoId = null; // 실패한 영상은 다시 시도할 수 있게 되돌린다
      post('ERROR', { videoId, message: String(err) });
    }
  }

  // --- player response 수집 경로 1: SPA 전환 시 나가는 player API 응답 가로채기 ---
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/youtubei/v1/player')) {
        promise
          .then((res) => res.clone().json())
          .then(handlePlayerResponse)
          .catch(() => {});
      } else if (url.includes('/api/timedtext')) {
        promise
          .then((res) => res.clone().text())
          .then((body) => handleTimedText(url, body))
          .catch(() => {});
      }
    } catch (_) {
      /* 가로채기 실패가 원래 요청을 막아서는 안 된다 */
    }
    return promise;
  };

  // --- 수집 경로 2: XHR 로 나가는 player API 응답 ---
  //
  // 유튜브는 경로에 따라 fetch 가 아니라 XHR 로 player 를 부른다. fetch 만 후킹하면
  // 그 경우를 통째로 놓쳐서, 자막이 있는 영상인데도 아무 일도 일어나지 않는다.
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = typeof url === 'string' ? url : '';
    this.__lfjpPlayer = u.includes('/youtubei/v1/player');
    this.__lfjpTimedText = u.includes('/api/timedtext') ? u : null;
    return originalOpen.call(this, method, url, ...rest);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__lfjpPlayer) {
      this.addEventListener('load', () => {
        try {
          handlePlayerResponse(JSON.parse(this.responseText));
        } catch (_) {
          /* player 응답이 아니면 무시 */
        }
      });
    } else if (this.__lfjpTimedText) {
      this.addEventListener('load', () => {
        handleTimedText(this.__lfjpTimedText, this.responseText);
      });
    }
    return originalSend.apply(this, args);
  };

  // --- 수집 경로 3: HTML 에 박혀 오는 ytInitialPlayerResponse ---
  //
  // SPA 전환마다 값이 갈리므로 한 번 성공했다고 영영 멈추면 안 된다. 검색 화면에서
  // 시작해 영상으로 들어가는 흐름이 정확히 그 경우다.
  function pollInitialResponse() {
    let polls = 0;
    const timer = setInterval(() => {
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails) {
        handlePlayerResponse(pr);
        clearInterval(timer);
      } else if (++polls > 100) {
        clearInterval(timer);
      }
    }, 100);
  }

  pollInitialResponse();
  window.addEventListener('yt-navigate-finish', pollInitialResponse);
})();
