/**
 * 오버레이 렌더러 — 사이트와 무관한 공통 레이어.
 *
 * 일본어 라인은 형태소 토큰이 도착하면 단어 단위 <span> 으로 다시 그린다.
 * 토큰이 아직 없거나 백엔드가 죽어 있으면 그냥 통짜 텍스트로 그린다 — 하이라이트가
 * 없어도 자막 자체는 절대 끊기면 안 되기 때문.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  let mount = null;
  let root = null;
  let jaEl = null;
  let koEl = null;
  let onWordClick = null;

  // 같은 내용을 매 프레임 다시 그리지 않기 위한 캐시
  let lastKey = null;
  let lastTokensLen = null; // null = 아직 안 그림 (-1 은 '토큰 없이 통짜로 그림')
  let lastKo = null;

  function build() {
    root = document.createElement('div');
    root.className = 'lfjp-overlay';

    jaEl = document.createElement('div');
    jaEl.className = 'lfjp-line lfjp-ja';

    koEl = document.createElement('div');
    koEl.className = 'lfjp-line lfjp-ko';

    root.append(jaEl, koEl);
    lastKey = null;
    lastTokensLen = null;
    lastKo = null;
  }

  /**
   * 플레이어가 오버레이를 날려버릴 수 있으므로 매 프레임 부착 상태를 확인한다.
   * @param {HTMLElement|null} mountPoint
   */
  function ensure(mountPoint) {
    if (!mountPoint) return false;
    if (root && mountPoint === mount && mountPoint.contains(root)) return true;

    mount = mountPoint;
    if (!root) build();
    // 툴팁/오버레이는 컨테이너 기준 absolute 라 부모가 static 이면 어긋난다.
    if (getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
    mount.appendChild(root);
    return true;
  }

  function renderTokenized(text, tokens) {
    jaEl.textContent = '';
    jaEl.appendChild(
      LFJP.renderTokens(text, tokens, (token, span) => {
        if (onWordClick) onWordClick(token, text, span, mount);
      })
    );
  }

  /**
   * @param {{key:string|number, text:string, ko:string, tokens:Array|null}} view
   */
  function render(view) {
    if (!root) return;
    const tokens = view.tokens || null;
    const tokensLen = tokens ? tokens.length : -1;

    if (view.key !== lastKey) {
      // cue 가 바뀌면 앞 문장에 붙어 있던 툴팁은 의미가 없다.
      LFJP.tooltip.close();
      lastKey = view.key;
      lastTokensLen = null;
    }

    if (tokensLen !== lastTokensLen) {
      lastTokensLen = tokensLen;
      if (tokens && tokens.length) renderTokenized(view.text, tokens);
      else jaEl.textContent = view.text;
    }

    if (view.ko !== lastKo) {
      lastKo = view.ko;
      koEl.textContent = view.ko || '';
    }

    root.style.display = view.text || view.ko ? '' : 'none';
  }

  function hide() {
    if (!root) return;
    LFJP.tooltip.close();
    root.style.display = 'none';
    lastKey = null;
    lastTokensLen = null;
    lastKo = null;
  }

  function destroy() {
    LFJP.tooltip.close();
    if (root) root.remove();
    root = jaEl = koEl = mount = null;
    lastKey = null;
    lastTokensLen = null;
    lastKo = null;
  }

  LFJP.overlay = {
    init(opts) {
      onWordClick = opts.onWordClick;
    },
    ensure,
    render,
    hide,
    destroy
  };
})();
