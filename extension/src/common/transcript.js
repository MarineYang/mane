/**
 * 트랜스크립트 패널 — 영상 옆에 대사를 쌓아 보여주는 학습 화면.
 *
 * 오버레이는 흘러가버려서 "지금 이 순간"만 담는다. 학습은 앞뒤를 오가며 하는 일이라
 * 대본 전체가 필요하다. 줄을 누르면 그 장면으로 뛰고, 재생 위치는 계속 따라간다.
 *
 * 자동 스크롤은 사용자가 직접 스크롤하면 잠시 멈춘다 — 위쪽을 읽고 있는데 화면이
 * 자꾸 끌려 내려가는 것만큼 방해되는 게 없다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  /** 사용자가 스크롤한 뒤 자동 추적을 다시 켜기까지의 유예 */
  const AUTOSCROLL_PAUSE_MS = 4000;

  let root = null;
  let listEl = null;
  let wordsEl = null;
  let shadowEl = null;
  let countEl = null;
  let filterBtn = null;
  let tabCuesBtn = null;
  let tabWordsBtn = null;
  let tabShadowBtn = null;
  let mount = null;
  let rows = [];
  let activeTab = 'cues';
  let contentId = '';
  let currentIndex = -1;
  let studyOnly = false;
  let userScrolledAt = 0;
  let handlers = {};
  let visible = true;
  let savedDate = new Date();
  let savedKind = '';
  let savedRequest = 0;

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(s / 60);
    const rest = s % 60;
    if (m < 60) return `${m}:${String(rest).padStart(2, '0')}`;
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  function localDateValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dateFromValue(value) {
    const parts = String(value || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function savedDateRange() {
    const from = new Date(savedDate.getFullYear(), savedDate.getMonth(), savedDate.getDate());
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from: from.toISOString(), to: to.toISOString() };
  }

  function formatSavedDate(date) {
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short'
    }).format(date);
  }

  function build() {
    root = document.createElement('div');
    root.className = 'lfjp-panel';

    const header = document.createElement('div');
    header.className = 'lfjp-panel-head';

    tabCuesBtn = document.createElement('button');
    tabCuesBtn.className = 'lfjp-tab on';
    tabCuesBtn.textContent = '대사';
    tabCuesBtn.addEventListener('click', () => setTab('cues'));

    tabWordsBtn = document.createElement('button');
    tabWordsBtn.className = 'lfjp-tab';
    tabWordsBtn.textContent = '보관함';
    tabWordsBtn.addEventListener('click', () => setTab('words'));

    tabShadowBtn = document.createElement('button');
    tabShadowBtn.className = 'lfjp-tab';
    tabShadowBtn.textContent = '쉐도잉';
    tabShadowBtn.addEventListener('click', () => setTab('shadowing'));

    countEl = document.createElement('span');
    countEl.className = 'lfjp-panel-count';

    filterBtn = document.createElement('button');
    filterBtn.className = 'lfjp-panel-filter';
    filterBtn.textContent = '전체';
    filterBtn.title = '학습 대상 단어가 있는 줄만 보기';
    filterBtn.addEventListener('click', () => {
      studyOnly = !studyOnly;
      filterBtn.textContent = studyOnly ? '학습' : '전체';
      filterBtn.classList.toggle('on', studyOnly);
      applyFilter();
    });

    header.append(tabCuesBtn, tabWordsBtn, tabShadowBtn, countEl, filterBtn);

    listEl = document.createElement('div');
    listEl.className = 'lfjp-panel-list';
    listEl.addEventListener('scroll', () => {
      userScrolledAt = Date.now();
    });

    wordsEl = document.createElement('div');
    wordsEl.className = 'lfjp-panel-list lfjp-words';
    wordsEl.style.display = 'none';

    shadowEl = document.createElement('div');
    shadowEl.className = 'lfjp-panel-list lfjp-shadowing';
    shadowEl.style.display = 'none';

    root.append(header, listEl, wordsEl, shadowEl);
  }

  function setTab(tab) {
    if (activeTab === 'shadowing' && tab !== 'shadowing' && handlers.onCloseShadowing) {
      handlers.onCloseShadowing();
    }
    activeTab = tab;
    const onCues = tab === 'cues';
    const onWords = tab === 'words';
    const onShadowing = tab === 'shadowing';
    tabCuesBtn.classList.toggle('on', onCues);
    tabWordsBtn.classList.toggle('on', onWords);
    tabShadowBtn.classList.toggle('on', onShadowing);
    listEl.style.display = onCues ? '' : 'none';
    wordsEl.style.display = onWords ? '' : 'none';
    shadowEl.style.display = onShadowing ? '' : 'none';
    filterBtn.style.display = onCues ? '' : 'none';
    if (onWords) loadWords();
    if (onShadowing && handlers.onOpenShadowing) handlers.onOpenShadowing(shadowEl);
  }

  /**
   * 저장한 표현 목록. 탭을 열 때마다 새로 불러온다 — 다른 영상에서 저장한 것도
   * 함께 쌓이므로 캐시해두면 금방 어긋난다.
   */
  async function loadWords() {
    const request = ++savedRequest;
    wordsEl.textContent = '';
    const resultsEl = buildSavedControls();
    const loading = document.createElement('div');
    loading.className = 'lfjp-status';
    loading.textContent = '불러오는 중…';
    resultsEl.appendChild(loading);

    const range = savedDateRange();
    const res = await LFJP.api.listExpressions({ ...range, kind: savedKind });
    if (activeTab !== 'words' || request !== savedRequest) return;

    resultsEl.textContent = '';
    if (!res.ok) {
      countEl.textContent = '';
      const err = document.createElement('div');
      err.className = 'lfjp-status';
      err.textContent = '불러오지 못했습니다: ' + res.error;
      resultsEl.appendChild(err);
      return;
    }

    countEl.textContent = `${res.total}개`;
    if (!res.expressions.length) {
      const empty = document.createElement('div');
      empty.className = 'lfjp-status';
      empty.textContent = savedKind === 'sentence'
        ? '이 날짜에 저장한 문장이 없습니다. 대사의 북마크를 눌러 저장해보세요.'
        : savedKind === 'word'
          ? '이 날짜에 저장한 단어가 없습니다. 대사에서 단어를 눌러 저장해보세요.'
          : '이 날짜에 저장한 단어나 문장이 없습니다.';
      resultsEl.appendChild(empty);
      return;
    }

    const groups = new Map();
    res.expressions.forEach((expression) => {
      const date = new Date(expression.created_at);
      const key = Number.isNaN(date.getTime()) ? 'unknown' : localDateValue(date);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(expression);
    });
    groups.forEach((expressions, key) => {
      const heading = document.createElement('div');
      heading.className = 'lfjp-saved-date-heading';
      const headingDate = key === 'unknown' ? '저장 날짜 없음' : dateFromValue(key);
      heading.textContent = headingDate instanceof Date ? formatSavedDate(headingDate) : headingDate;
      resultsEl.appendChild(heading);
      expressions.forEach((e) => resultsEl.appendChild(buildWordRow(e)));
    });
  }

  function buildSavedControls() {
    const controls = document.createElement('div');
    controls.className = 'lfjp-saved-controls';

    const dateRow = document.createElement('div');
    dateRow.className = 'lfjp-saved-date-nav';
    const prev = document.createElement('button');
    prev.textContent = '‹';
    prev.title = '이전 날짜';
    prev.addEventListener('click', () => shiftSavedDate(-1));
    const input = document.createElement('input');
    input.type = 'date';
    input.value = localDateValue(savedDate);
    input.setAttribute('aria-label', '저장 날짜');
    input.addEventListener('change', () => {
      const next = dateFromValue(input.value);
      if (next) {
        savedDate = next;
        loadWords();
      }
    });
    const next = document.createElement('button');
    next.textContent = '›';
    next.title = '다음 날짜';
    next.addEventListener('click', () => shiftSavedDate(1));
    const today = document.createElement('button');
    today.textContent = '오늘';
    today.addEventListener('click', () => {
      savedDate = new Date();
      loadWords();
    });
    dateRow.append(prev, input, next, today);

    const kindRow = document.createElement('div');
    kindRow.className = 'lfjp-saved-kind-filter';
    [['', '전체'], ['word', '단어'], ['sentence', '문장']].forEach(([kind, label]) => {
      const button = document.createElement('button');
      button.textContent = label;
      button.classList.toggle('on', savedKind === kind);
      button.addEventListener('click', () => {
        savedKind = kind;
        loadWords();
      });
      kindRow.appendChild(button);
    });

    const results = document.createElement('div');
    results.className = 'lfjp-saved-results';
    controls.append(dateRow, kindRow);
    wordsEl.append(controls, results);
    return results;
  }

  function shiftSavedDate(days) {
    const next = new Date(savedDate);
    next.setDate(next.getDate() + days);
    savedDate = next;
    loadWords();
  }

  function buildWordRow(e) {
    const el = document.createElement('div');
    el.className = 'lfjp-word-row';

    const head = document.createElement('div');
    head.className = 'lfjp-word-head';

    const surface = document.createElement('span');
    surface.className = 'lfjp-word-surface';
    surface.textContent = e.surface;
    head.appendChild(surface);

    const kind = document.createElement('span');
    kind.className = 'lfjp-word-kind';
    kind.textContent = e.kind === 'sentence' ? '문장' : '단어';
    head.appendChild(kind);

    if (e.reading) {
      const reading = document.createElement('span');
      reading.className = 'lfjp-word-reading';
      reading.textContent = e.reading;
      head.appendChild(reading);
    }
    if (e.jlpt) {
      const badge = document.createElement('span');
      badge.className = 'lfjp-word-jlpt';
      badge.textContent = e.jlpt;
      head.appendChild(badge);
    }

    const del = document.createElement('button');
    del.className = 'lfjp-word-del';
    del.textContent = '삭제';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      del.disabled = true;
      const res = await LFJP.api.deleteExpression(e.id);
      if (res.ok) loadWords();
      else del.disabled = false;
    });
    head.appendChild(del);

    el.appendChild(head);

    if (e.gloss) {
      const gloss = document.createElement('div');
      gloss.className = 'lfjp-word-gloss';
      gloss.textContent = e.gloss;
      el.appendChild(gloss);
    }

    if (e.context && e.context !== e.surface) {
      const ctx = document.createElement('div');
      ctx.className = 'lfjp-word-ctx';
      ctx.textContent = e.context;
      el.appendChild(ctx);
    }

    const src = e.source || {};
    const meta = document.createElement('div');
    meta.className = 'lfjp-word-meta';
    const sameVideo = src.content_id && src.content_id === contentId;
    meta.textContent = sameVideo
      ? `${formatTime(src.time_sec)} · 이 영상 · ${formatSavedTime(e.created_at)}`
      : `${formatTime(src.time_sec)} · ${src.title || src.content_id || '다른 영상'} · ${formatSavedTime(e.created_at)}`;
    el.appendChild(meta);

    // 같은 영상에서 저장한 단어만 장면으로 되돌아갈 수 있다.
    if (sameVideo) {
      el.classList.add('lfjp-word-seekable');
      el.addEventListener('click', () => {
        if (handlers.onSeek) handlers.onSeek(src.time_sec || 0);
      });
    }

    return el;
  }

  function formatSavedTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '저장 시각 없음';
    return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  /** 학습 대상 단어가 하나라도 있는 줄인지 — 필터의 기준. */
  function isStudyRow(row) {
    return (row.tokens || []).some((t) => t.highlight);
  }

  function applyFilter() {
    for (const row of rows) {
      const hide = studyOnly && row.analyzed && !isStudyRow(row);
      row.el.classList.toggle('lfjp-row-hidden', hide);
    }
  }

  /**
   * 대사 대신 현재 상태를 보여준다.
   *
   * 패널은 자막이 오기 전에도 떠 있어야 한다 — 아무것도 없으면 사용자는 확장이
   * 죽었는지 자막이 없는 영상인지 구분할 수 없고, 켜고 끌 대상도 없다.
   */
  function setStatus(message) {
    if (!root) build();
    listEl.textContent = '';
    rows = [];
    currentIndex = -1;

    const el = document.createElement('div');
    el.className = 'lfjp-status';
    el.textContent = message;
    listEl.appendChild(el);
    if (activeTab === 'cues') countEl.textContent = '';
  }

  function render(cues, videoId) {
    if (!root) build();
    contentId = videoId || contentId;
    listEl.textContent = '';
    rows = [];
    currentIndex = -1;

    cues.forEach((cue, i) => {
      const el = document.createElement('div');
      el.className = 'lfjp-row';

      const top = document.createElement('div');
      top.className = 'lfjp-row-top';

      const time = document.createElement('div');
      time.className = 'lfjp-row-time';
      time.textContent = formatTime(cue.start);

      const bookmark = document.createElement('button');
      bookmark.className = 'lfjp-row-bookmark';
      bookmark.textContent = '☆';
      bookmark.title = '문장 저장';
      bookmark.setAttribute('aria-label', '문장 저장');
      bookmark.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!handlers.onSaveSentence || bookmark.disabled) return;
        bookmark.disabled = true;
        bookmark.classList.remove('error');
        bookmark.textContent = '…';
        const res = await handlers.onSaveSentence(cue, ko.textContent || '');
        if (res && res.ok) {
          bookmark.textContent = '★';
          bookmark.title = '저장됨';
          bookmark.classList.add('saved');
        } else {
          bookmark.textContent = '!';
          bookmark.title = '저장 실패: ' + ((res && res.error) || '알 수 없는 오류');
          bookmark.classList.add('error');
          bookmark.disabled = false;
        }
      });
      top.append(time, bookmark);

      const ja = document.createElement('div');
      ja.className = 'lfjp-row-ja';
      ja.textContent = cue.text;

      const ko = document.createElement('div');
      ko.className = 'lfjp-row-ko';

      el.append(top, ja, ko);

      // 줄 아무 데나 누르면 그 장면으로. 단어 클릭은 자기 선에서 멈추므로 안 섞인다.
      el.addEventListener('click', () => {
        if (handlers.onSeek) handlers.onSeek(cue.start);
      });

      listEl.appendChild(el);
      rows.push({ el, ja, ko, cue, tokens: null, analyzed: false });
    });

    if (activeTab === 'cues') countEl.textContent = `${cues.length}줄`;
  }

  /** 번역이 도착하면 채운다. cues 와 같은 인덱스. */
  function setTranslations(ko) {
    rows.forEach((row, i) => {
      const text = (ko && ko[i]) || '';
      if (row.ko.textContent !== text) row.ko.textContent = text;
    });
  }

  /** 형태소 분석이 도착한 줄만 단어 단위로 다시 그린다. */
  function setTokens(index, tokens) {
    const row = rows[index];
    if (!row) return;
    row.tokens = tokens || [];
    row.analyzed = true;

    row.ja.textContent = '';
    if (row.tokens.length) {
      row.ja.appendChild(
        LFJP.renderTokens(row.cue.text, row.tokens, (token, span) => {
          if (handlers.onWordClick) handlers.onWordClick(token, row.cue, span, root);
        })
      );
    } else row.ja.textContent = row.cue.text;
    if (studyOnly) applyFilter();
  }

  function setCurrent(index) {
    if (index === currentIndex) return;
    if (rows[currentIndex]) rows[currentIndex].el.classList.remove('lfjp-row-on');
    currentIndex = index;

    const row = rows[index];
    if (!row) return;
    row.el.classList.add('lfjp-row-on');

    // 사용자가 방금 스크롤했다면 끌고 가지 않는다.
    if (Date.now() - userScrolledAt < AUTOSCROLL_PAUSE_MS) return;
    const prev = userScrolledAt;
    row.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // scrollIntoView 가 발생시키는 scroll 이벤트를 사용자 조작으로 오해하면 안 된다.
    setTimeout(() => {
      userScrolledAt = prev;
    }, 0);
  }

  /** 패널을 숨겨도 대사 추적은 계속 돈다 — 다시 켜면 현재 위치가 맞아 있어야 한다. */
  function setVisible(next) {
    visible = next;
    if (!visible && handlers.onCloseShadowing) handlers.onCloseShadowing();
    if (root) root.style.display = visible ? '' : 'none';
  }

  function ensure(mountPoint) {
    if (!mountPoint) return false;
    if (root && mountPoint === mount && mountPoint.contains(root)) return true;
    mount = mountPoint;
    if (!root) build();
    mount.prepend(root);
    root.style.display = visible ? '' : 'none';
    return true;
  }

  function destroy() {
    if (root) root.remove();
    root = listEl = wordsEl = shadowEl = countEl = mount = null;
    rows = [];
    currentIndex = -1;
  }

  LFJP.transcript = {
    init(opts) {
      handlers = opts || {};
    },
    setVisible,
    isVisible: () => visible,
    setStatus,
    ensure,
    render,
    setTranslations,
    setTokens,
    setCurrent,
    destroy
  };
})();
