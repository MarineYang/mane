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
  let learningToggle = null;
  let toggleStateEl = null;
  let toggleHandler = null;
  let toggleShown = null; // 마지막으로 DOM 에 반영한 ON/OFF. null 이면 아직 안 그림
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
        meta: payload.meta || {},
        translations: payload.translations || []
      });
      return;
    }
    if (data.type === 'NETFLIX_UNAVAILABLE') {
      handlers.onUnavailable({ available: payload.available || [] });
      return;
    }
    if (data.type === 'NETFLIX_ERROR') {
      handlers.onError({ message: payload.message || 'Netflix 자막 취득 실패' });
      return;
    }
    if (data.type === 'NETFLIX_SEEK_UNAVAILABLE') {
      LFJP.warn('Netflix 장면 이동을 사용할 수 없습니다:', payload.message || '플레이어 API 없음');
    }
  }

  function sendConfig() {
    chrome.storage.sync.get({ sourceLang: 'ja', targetLang: 'ko' }).then(({ sourceLang, targetLang }) => {
      window.postMessage({
        __langflix: LFJP.CHANNEL,
        type: 'NETFLIX_CONFIG',
        payload: { sourceLang, targetLang }
      }, '*');
    });
  }

  /**
   * OFF 일 때 넷플릭스를 원래 화면으로 되돌린다.
   *
   * ensurePanelMount 가 매 프레임 학습용 클래스를 다시 붙이기 때문에, 끄는 시점에
   * 한 번 걷어내는 것만으로는 다음 프레임에 되살아난다. 그래서 "복귀"도 켜짐
   * 여부를 보고 매 프레임 판단한다.
   */
  function restoreNativeStage(root) {
    if (!root) return;
    root.classList.remove('lfjp-netflix-learning-player');
    root.querySelectorAll('.lfjp-netflix-native-stage').forEach((el) => {
      el.classList.remove('lfjp-netflix-native-stage');
    });
  }

  function ensurePanelMount() {
    if (!location.pathname.startsWith('/watch')) return null;
    const root = getPlayerRoot();
    if (!root) return null;
    // 학습 화면이 꺼져 있으면 패널도 무대 변형도 만들지 않는다.
    if (toggleShown === false) {
      restoreNativeStage(root);
      if (panelMount) panelMount.style.display = 'none';
      return panelMount;
    }
    if (!panelMount || !root.contains(panelMount)) {
      panelMount = document.createElement('div');
      panelMount.className = 'lfjp-netflix-panel-mount';
      root.appendChild(panelMount);
    }
    // Netflix는 영상·자막·재생바를 여러 개의 전체화면 형제 레이어로 만든다.
    // video 하나만 줄이면 나머지 레이어는 패널 뒤로 잘리므로 네이티브 최상위
    // 레이어를 모두 같은 학습용 사각형 안에 넣는다. SPA가 레이어를 교체하므로
    // 매 프레임 호출되는 ensure 경로에서 새 형제도 표시한다.
    Array.from(root.children).forEach((child) => {
      if (child.matches(
        '.lfjp-netflix-panel-mount, .lfjp-overlay, .lfjp-tooltip, .lfjp-player-toggle'
      )) return;
      child.classList.add('lfjp-netflix-native-stage');
    });
    root.classList.add('lfjp-netflix-learning-player');
    return panelMount;
  }

  /**
   * 토글은 플레이어 루트에 붙인다.
   *
   * 재생 컨트롤 안에 넣으면 넷플릭스가 컨트롤바를 통째로 숨길 때(마우스를 몇 초
   * 안 움직이면, 그리고 전체화면에서 특히 자주) 같이 사라진다. 학습 화면을 끄고
   * 켜는 스위치가 "마우스를 흔들어야 나타나는" 물건이면 안 되므로 컨트롤바와
   * 수명을 분리했다.
   */
  function ensureLearningToggle(active, onToggle) {
    if (!location.pathname.startsWith('/watch')) return null;
    const playerRoot = getPlayerRoot();
    if (!playerRoot) return null;

    toggleHandler = onToggle;
    if (!learningToggle) {
      learningToggle = document.createElement('button');
      learningToggle.type = 'button';
      learningToggle.className = 'lfjp-player-toggle';
      learningToggle.title = 'LangFlix 학습 화면 켜기/끄기 (Option+J)';
      learningToggle.setAttribute('aria-label', 'LangFlix 학습 화면 켜기/끄기');
      learningToggle.appendChild(
        Object.assign(document.createElement('span'), {
          className: 'lfjp-player-toggle-mark',
          textContent: 'LF'
        })
      );
      toggleStateEl = Object.assign(document.createElement('span'), {
        className: 'lfjp-player-toggle-state'
      });
      learningToggle.appendChild(toggleStateEl);
      learningToggle.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (toggleHandler) toggleHandler();
      });
    }
    if (learningToggle.parentElement !== playerRoot) playerRoot.appendChild(learningToggle);
    updateLearningToggle(active);
    return learningToggle;
  }

  /**
   * ON/OFF 표시를 갱신한다. 이 함수는 렌더 루프에서 매 프레임 불리므로 상태가
   * 실제로 바뀌었을 때만 DOM 을 건드린다 — 매번 다시 그리면 초당 60번 노드가
   * 교체되어 깜빡이고, hover 가 풀리고, 클릭이 씹힌다.
   */
  function updateLearningToggle(active) {
    const enabled = Boolean(active);
    const root = getPlayerRoot();
    if (toggleShown === enabled) {
      // 넷플릭스가 SPA 전환으로 무대를 갈아끼울 수 있으므로 클래스만 확인한다.
      if (root && enabled) root.classList.add('lfjp-netflix-learning-player');
      return;
    }
    toggleShown = enabled;

    if (learningToggle) {
      learningToggle.classList.toggle('on', enabled);
      learningToggle.setAttribute('aria-pressed', String(enabled));
      if (toggleStateEl) toggleStateEl.textContent = enabled ? 'ON' : 'OFF';
    }
    if (panelMount) panelMount.style.display = enabled ? '' : 'none';
    if (enabled) {
      if (root) root.classList.add('lfjp-netflix-learning-player');
    } else {
      restoreNativeStage(root);
      // 학습 언어 트랙은 우리가 대신 골라둔 것이다. 끌 때 사용자의 원래 선택으로
      // 돌려놓지 않으면 넷플릭스 자막이 일본어인 채로 남는다.
      window.postMessage({ __langflix: LFJP.CHANNEL, type: 'NETFLIX_RESTORE_TRACK' }, '*');
    }
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
      window.postMessage({ __langflix: LFJP.CHANNEL, type: 'NETFLIX_RESTORE_TRACK' }, '*');
      window.removeEventListener('message', onWindowMessage);
      if (panelMount) panelMount.remove();
      if (learningToggle) learningToggle.remove();
      restoreNativeStage(getPlayerRoot());
      panelMount = null;
      learningToggle = null;
      toggleStateEl = null;
      toggleHandler = null;
      toggleShown = null;
    },

    getCurrentTime() {
      const video = document.querySelector('video');
      return video ? video.currentTime : null;
    },

    getMountPoint() {
      return getPlayerRoot();
    },

    seekTo(seconds) {
      window.postMessage({
        __langflix: LFJP.CHANNEL,
        type: 'NETFLIX_SEEK',
        payload: { seconds }
      }, '*');
    },

    getMediaElement() {
      return document.querySelector('video');
    },

    getPanelMount() {
      return ensurePanelMount();
    },

    ensureLearningToggle,

    updateLearningToggle,

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
