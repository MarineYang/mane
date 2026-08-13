/**
 * 격리 환경(content script)에서 실행되는 공통 레이어.
 *
 * 사이트별로 갈리는 것(자막 cue 취득)은 injected.js 쪽 어댑터가 담당하고,
 * 이 파일은 어댑터가 넘겨준 cue를 화면에 올리고 재생 시각에 맞춰 동기화하는
 * "공통 레이어"만 담당한다. NetflixAdapter 를 붙일 때 이 파일은 거의 그대로 재사용된다.
 */
(() => {
  'use strict';

  const CHANNEL = 'LANGFLIX_JP';
  const log = (...a) => console.log('%c[langflix-jp]', 'color:#4ea1ff', ...a);

  // 페이지 컨텍스트에 어댑터 주입
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('src/injected.js');
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  const state = { ja: [], ko: [], videoId: null, enabled: true };
  let overlayEl = null;
  let jaEl = null;
  let koEl = null;
  let rafId = null;

  // ---------------------------------------------------------------- 메시지 수신

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__langflix !== CHANNEL) return;

    if (data.type === 'CUES') {
      state.ja = data.payload.ja || [];
      state.ko = data.payload.ko || [];
      state.videoId = data.payload.videoId;
      log(
        `자막 로드 완료 — 일본어 ${state.ja.length}줄 / 한국어 ${state.ko.length}줄`,
        data.payload.meta
      );
      startLoop();
    } else if (data.type === 'NO_JA_TRACK') {
      log('이 영상에는 일본어 자막 트랙이 없습니다.', data.payload.available);
      teardown();
    } else if (data.type === 'ERROR') {
      console.warn('[langflix-jp] 자막 취득 실패:', data.payload.message);
    }
  });

  // ---------------------------------------------------------------- 플레이어 접근

  const getPlayer = () =>
    document.querySelector('#movie_player') ||
    document.querySelector('.html5-video-player');

  const getVideo = () => {
    const player = getPlayer();
    return (player && player.querySelector('video')) || document.querySelector('video');
  };

  /** 플레이어가 오버레이를 날려버릴 수 있으므로 매 프레임 부착 상태를 확인한다. */
  function ensureOverlay() {
    const player = getPlayer();
    if (!player) return false;
    if (overlayEl && player.contains(overlayEl)) return true;

    overlayEl = document.createElement('div');
    overlayEl.className = 'lfjp-overlay';

    jaEl = document.createElement('div');
    jaEl.className = 'lfjp-line lfjp-ja';

    koEl = document.createElement('div');
    koEl.className = 'lfjp-line lfjp-ko';

    overlayEl.append(jaEl, koEl);
    player.appendChild(overlayEl);
    return true;
  }

  // ---------------------------------------------------------------- 동기화

  /** cue는 시작 시각 오름차순이므로 이진 탐색으로 현재 cue를 찾는다. */
  function findCue(cues, t) {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cue = cues[mid];
      if (t < cue.start) hi = mid - 1;
      else if (t >= cue.end) lo = mid + 1;
      else return cue;
    }
    return null;
  }

  function startLoop() {
    stopLoop();
    const tick = () => {
      rafId = requestAnimationFrame(tick);

      const video = getVideo();
      if (!video || !ensureOverlay()) return;

      // 배속·seek·버퍼링에 관계없이 항상 currentTime을 기준으로 다시 계산한다.
      const t = video.currentTime;
      const jaText = state.enabled ? (findCue(state.ja, t) || {}).text || '' : '';
      const koText = state.enabled ? (findCue(state.ko, t) || {}).text || '' : '';

      if (jaEl.textContent !== jaText) jaEl.textContent = jaText;
      if (koEl.textContent !== koText) koEl.textContent = koText;
      overlayEl.style.display = jaText || koText ? '' : 'none';
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function teardown() {
    stopLoop();
    if (overlayEl) overlayEl.remove();
    overlayEl = jaEl = koEl = null;
    state.ja = [];
    state.ko = [];
  }

  // ---------------------------------------------------------------- SPA / 조작

  // 유튜브는 페이지를 리로드하지 않으므로 영상 전환 시 이전 자막을 반드시 걷어낸다.
  window.addEventListener('yt-navigate-start', teardown);

  // Alt+J : 이중자막 표시 토글
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'j' || e.key === 'J')) {
      state.enabled = !state.enabled;
      log('이중자막', state.enabled ? 'ON' : 'OFF');
    }
  });
})();
