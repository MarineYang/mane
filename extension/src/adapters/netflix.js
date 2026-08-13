/**
 * NetflixAdapter — 페이지 컨텍스트에서 포착한 TTML/WebVTT cue를 공통 레이어로 넘긴다.
 *
 * 실제 응답 후킹과 파싱은 netflix-injected.js가 담당한다. 이 파일은 격리된 content
 * script에서 메시지를 받고 플레이어 시간·패널 mount를 제공한다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  let handlers = null;
  let injected = false;
  let panelMount = null;
  let contentMeta = { platform: 'netflix', contentId: '', title: '' };

  const getPlayerRoot = () =>
    document.querySelector('.watch-video--player-view') ||
    document.querySelector('.nf-player-container') ||
    (document.querySelector('video') && document.querySelector('video').parentElement);

  function onWindowMessage(event) {
    if (event.source !== window || !handlers) return;
    const data = event.data;
    if (!data || data.__langflix !== LFJP.CHANNEL) return;
    const payload = data.payload || {};

    if (data.type === 'NETFLIX_DEBUG') {
      LFJP.log('[Netflix 주입]', payload.msg, payload.data || '');
      return;
    }
    if (data.type === 'NETFLIX_NAVIGATE') {
      contentMeta = {
        platform: 'netflix',
        contentId: payload.contentId || '',
        title: document.title
      };
      handlers.onNavigate();
      return;
    }
    if (data.type === 'NETFLIX_CUES') {
      contentMeta = {
        platform: 'netflix',
        contentId: payload.contentId || '',
        title: payload.title || document.title
      };
      handlers.onCues({
        contentId: contentMeta.contentId,
        cues: payload.cues || [],
        meta: payload.meta || {}
      });
      return;
    }
    if (data.type === 'NETFLIX_ERROR') {
      handlers.onError({ message: payload.message || 'Netflix 자막 취득 실패' });
    }
  }

  function sendConfig() {
    chrome.storage.sync.get({ sourceLang: 'ja' }).then(({ sourceLang }) => {
      window.postMessage({
        __langflix: LFJP.CHANNEL,
        type: 'NETFLIX_CONFIG',
        payload: { sourceLang }
      }, '*');
    });
  }

  function ensurePanelMount() {
    if (!location.pathname.startsWith('/watch')) return null;
    const root = getPlayerRoot();
    if (!root) return null;
    if (panelMount && root.contains(panelMount)) return panelMount;
    panelMount = document.createElement('div');
    panelMount.className = 'lfjp-netflix-panel-mount';
    root.appendChild(panelMount);
    return panelMount;
  }

  /** @type {import('../common/subtitle-source.js').SubtitleSource} */
  const NetflixAdapter = {
    platform: 'netflix',

    matches(url) {
      // 홈에서 /watch로 SPA 이동해도 controller가 이미 살아 있어야 한다.
      return /(^|\.)netflix\.com$/.test(url.hostname);
    },

    attach(h) {
      handlers = h;
      window.addEventListener('message', onWindowMessage);
      sendConfig();

      if (injected) return;
      injected = true;
      // MAIN world manifest 주입을 지원하지 않는 구형 Chromium 대비 경로.
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('adapters/netflix-injected.js');
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    },

    detach() {
      handlers = null;
      window.removeEventListener('message', onWindowMessage);
      if (panelMount) panelMount.remove();
      panelMount = null;
    },

    getCurrentTime() {
      const video = document.querySelector('video');
      return video ? video.currentTime : null;
    },

    getMountPoint() {
      return getPlayerRoot();
    },

    seekTo(seconds) {
      const video = document.querySelector('video');
      if (video) video.currentTime = seconds;
    },

    getMediaElement() {
      return document.querySelector('video');
    },

    getPanelMount() {
      return ensurePanelMount();
    },

    getContentMeta() {
      // /watch/<id> 의 id 가 넷플릭스의 콘텐츠 식별자다.
      const m = location.pathname.match(/\/watch\/(\d+)/);
      const currentId = m ? m[1] : '';
      if (currentId && currentId !== contentMeta.contentId) {
        contentMeta = { platform: 'netflix', contentId: currentId, title: document.title };
      }
      return { ...contentMeta, title: document.title || contentMeta.title };
    }
  };

  LFJP.registerAdapter(NetflixAdapter);
})();
