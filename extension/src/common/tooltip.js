/**
 * 단어 툴팁 — 뜻풀이 표시 + 표현 저장.
 *
 * 사이트와 무관한 공통 레이어. 오버레이와 같은 컨테이너에 붙여 전체화면에서도
 * 같이 따라가게 한다(별도 body 부착이면 전체화면에서 사라진다).
 *
 * NLP 스텁 모드에서는 reading/jlpt/gloss 가 통째로 비어 온다. 그때도 surface 와
 * 저장 버튼만으로 쓸모가 있어야 하므로 빈 필드는 행 자체를 그리지 않는다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  let el = null;
  let statusEl = null;
  let current = null; // { token, context, source }

  function close() {
    if (el) el.remove();
    el = null;
    statusEl = null;
    current = null;
  }

  function row(label, value) {
    const div = document.createElement('div');
    div.className = 'lfjp-tip-row';
    const k = document.createElement('span');
    k.className = 'lfjp-tip-key';
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'lfjp-tip-val';
    v.textContent = value;
    div.append(k, v);
    return div;
  }

  async function save() {
    if (!current) return;
    const { token, context, source } = current;
    statusEl.textContent = '저장 중…';
    statusEl.className = 'lfjp-tip-status';

    const res = await LFJP.api.saveExpression({
      surface: token.surface,
      reading: token.reading,
      gloss: token.gloss,
      jlpt: token.jlpt,
      context,
      source
    });

    if (res.ok) {
      statusEl.textContent = '저장했습니다 ✓';
      statusEl.className = 'lfjp-tip-status lfjp-ok';
      setTimeout(() => {
        // 같은 툴팁이 아직 떠 있을 때만 닫는다(사용자가 다른 단어를 눌렀을 수 있음).
        if (current && current.token === token) close();
      }, 900);
    } else {
      statusEl.textContent = '저장 실패: ' + res.error;
      statusEl.className = 'lfjp-tip-status lfjp-err';
      LFJP.warn('표현 저장 실패:', res.error);
    }
  }

  /**
   * @param {HTMLElement} anchor   클릭된 단어 span
   * @param {HTMLElement} mount    오버레이가 붙어 있는 컨테이너
   * @param {Object} token         /v1/nlp/analyze 의 토큰
   * @param {string} context       cue 전체 문장
   * @param {Object} source        { platform, content_id, title, time_sec }
   */
  function open(anchor, mount, token, context, source) {
    close();
    current = { token, context, source };

    el = document.createElement('div');
    el.className = 'lfjp-tooltip';

    const head = document.createElement('div');
    head.className = 'lfjp-tip-head';
    const surface = document.createElement('span');
    surface.className = 'lfjp-tip-surface';
    surface.textContent = token.surface || '';
    head.appendChild(surface);
    if (token.jlpt) {
      const badge = document.createElement('span');
      badge.className = 'lfjp-tip-jlpt';
      badge.textContent = token.jlpt;
      head.appendChild(badge);
    }
    el.appendChild(head);

    if (token.reading) el.appendChild(row('읽기', token.reading));
    if (token.gloss) el.appendChild(row('뜻', token.gloss));
    if (!token.reading && !token.gloss) {
      const note = document.createElement('div');
      note.className = 'lfjp-tip-note';
      note.textContent = '사전 정보 없음 (NLP 스텁 모드)';
      el.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'lfjp-tip-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'lfjp-tip-save';
    saveBtn.textContent = '저장';
    saveBtn.addEventListener('click', save);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'lfjp-tip-close';
    closeBtn.textContent = '닫기';
    closeBtn.addEventListener('click', close);
    actions.append(saveBtn, closeBtn);
    el.appendChild(actions);

    statusEl = document.createElement('div');
    statusEl.className = 'lfjp-tip-status';
    el.appendChild(statusEl);

    mount.appendChild(el);

    // 단어 바로 위에 띄우되 컨테이너 밖으로 나가지 않게 가둔다.
    const m = mount.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    let left = a.left - m.left + a.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, m.width - w - 8));
    const top = Math.max(8, a.top - m.top - el.offsetHeight - 10);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  LFJP.tooltip = { open, close, isOpen: () => !!el };
})();
