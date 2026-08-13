/**
 * YouTubeAdapter — SubtitleSource 구현 (계약은 common/subtitle-source.js 참고).
 *
 * cue 취득 자체는 페이지 컨텍스트에서만 가능하므로 adapters/youtube-injected.js 를
 * 주입하고, 그 결과를 window.postMessage 로 받아 공통 레이어에 넘긴다.
 * 이 파일은 그 배선 + 플레이어 핸들(현재 시각·오버레이 부착점)만 담당한다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  let injected = false;
  let handlers = null;
  let contentMeta = { platform: 'youtube', contentId: '', title: '' };

  function onWindowMessage(ev) {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__langflix !== LFJP.CHANNEL || !handlers) return;

    const p = data.payload || {};
    if (data.type === 'DEBUG') {
      LFJP.log('[주입]', p.msg, p.data || '');
      return;
    }
    if (data.type === 'CUES') {
      contentMeta = {
        platform: 'youtube',
        contentId: p.contentId || '',
        title: p.title || document.title
      };
      handlers.onCues({ contentId: contentMeta.contentId, cues: p.cues || [], meta: p.meta });
    } else if (data.type === 'NO_JA_TRACK' || data.type === 'NO_SOURCE_TRACK') {
      handlers.onUnavailable({ available: p.available || [] });
    } else if (data.type === 'NEEDS_CC') {
      // 트랙은 있는데 우리가 직접 못 받는 상태 — 사용자가 자막을 켜면 해결된다.
      handlers.onUnavailable({ needsCC: true, lang: p.lang });
    } else if (data.type === 'ERROR') {
      handlers.onError({ message: p.message });
    }
  }

  // 유튜브는 페이지를 리로드하지 않으므로 영상 전환 시 이전 자막을 반드시 걷어낸다.
  function onNavigateStart() {
    if (handlers) handlers.onNavigate();
  }

  const getPlayer = () =>
    document.querySelector('#movie_player') ||
    document.querySelector('.html5-video-player');

  /** @type {import('../common/subtitle-source.js').SubtitleSource} */
  const YouTubeAdapter = {
    platform: 'youtube',

    matches(url) {
      return /(^|\.)youtube\.com$/.test(url.hostname);
    },

    attach(h) {
      handlers = h;
      window.addEventListener('message', onWindowMessage);
      window.addEventListener('yt-navigate-start', onNavigateStart);

      // 주입은 문서당 한 번. SPA 전환은 주입된 쪽의 fetch 후킹이 이미 잡는다.
      if (injected) return;
      injected = true;
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('adapters/youtube-injected.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);

      chrome.storage.sync
        .get({ sourceLang: 'ja' })
        .then(({ sourceLang }) => {
          window.postMessage({
            __langflix: LFJP.CHANNEL,
            type: 'CONFIG',
            payload: { sourceLang }
          }, '*');
        });
    },

    detach() {
      handlers = null;
      window.removeEventListener('message', onWindowMessage);
      window.removeEventListener('yt-navigate-start', onNavigateStart);
    },

    getCurrentTime() {
      const player = getPlayer();
      const video = (player && player.querySelector('video')) || document.querySelector('video');
      return video ? video.currentTime : null;
    },

    getMountPoint() {
      // 플레이어 컨테이너에 붙여야 전체화면·미니플레이어에서도 자막이 따라간다.
      return getPlayer();
    },

    seekTo(seconds) {
      const player = getPlayer();
      const video = (player && player.querySelector('video')) || document.querySelector('video');
      if (video) video.currentTime = seconds;
    },

    getMediaElement() {
      const player = getPlayer();
      return (player && player.querySelector('video')) || document.querySelector('video');
    },

    getPanelMount() {
      // 추천 영상 칼럼 맨 위. 오버레이와 달리 페이지 레이아웃 안에 들어가야
      // 스크롤·리사이즈에 자연스럽게 따라간다.
      return document.querySelector('#secondary-inner') || document.querySelector('#secondary');
    },

    getContentMeta() {
      return contentMeta;
    }
  };

  LFJP.registerAdapter(YouTubeAdapter);
})();
