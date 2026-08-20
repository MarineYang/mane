/**
 * 공통 레이어의 진입점 — 어댑터 선택 → cue 취득 → 번역 → 하이라이트 → 렌더 배선.
 *
 * 여기에는 사이트 고유 지식이 하나도 없다. 사이트별로 다른 것은 전부
 * SubtitleSource 뒤에 있다(common/subtitle-source.js).
 *
 * 실패 정책: 백엔드가 죽어 있어도 원문 라인은 반드시 나온다.
 * 번역이 실패하면 보조 라인만 비고, 분석이 실패하면 하이라이트만 없다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  const adapter = LFJP.pickAdapter(new URL(location.href));
  if (!adapter) return;

  const state = {
    cues: [],
    ko: [], // cues 와 같은 인덱스의 보조 언어 번역
    tokens: new Map() // cue index → 토큰 배열 (분석 실패 시 빈 배열)
  };

  let rafId = null;
  let translateWarned = false;
  let analyzeWarned = false;
  let learningVisible = true;
  let activeCueIndex = -1;

  function setLearningVisible(next) {
    learningVisible = Boolean(next);
    LFJP.transcript.setVisible(learningVisible);
    if (!learningVisible) {
      LFJP.overlay.hide();
      LFJP.tooltip.close();
    }
    if (adapter.updateLearningToggle) adapter.updateLearningToggle(learningVisible);
  }

  function seekCue(index) {
    if (!state.cues.length || !adapter.seekTo) return;
    const next = Math.max(0, Math.min(index, state.cues.length - 1));
    adapter.seekTo(state.cues[next].start);
  }

  const previousCue = () => seekCue(activeCueIndex > 0 ? activeCueIndex - 1 : 0);
  const replayCue = () => seekCue(activeCueIndex >= 0 ? activeCueIndex : 0);
  const nextCue = () => seekCue(activeCueIndex >= 0 ? activeCueIndex + 1 : 0);

  // ---------------------------------------------------------------- 번역

  // 첫 묶음은 작게 — 지금 화면에 뜰 줄의 한국어가 최대한 빨리 나와야 한다.
  // 그다음부터는 크게 — 한 화가 수백 줄이라 10줄씩 끊으면 왕복만 수십 번이고,
  // 보고 있는 장면의 번역이 몇 분 뒤에야 도착한다. 백엔드 상한은 요청당 500줄.
  const FIRST_TRANSLATE_CHUNK = 30;
  const TRANSLATE_CHUNK = 150;

  /** 재생 시각 t 이후(또는 t를 포함하는) 첫 cue. 없으면 0. */
  function firstCueAtOrAfter(cues, t) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].end <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo < cues.length ? lo : 0;
  }

  async function loadTranslations(cues, provided) {
    const initial = Array.isArray(provided) ? provided : [];
    state.ko = cues.map((_, i) => initial[i] || '');
    LFJP.transcript.setTranslations(state.ko);

    // 지금 재생 중인 위치부터 채운다. 무조건 0번부터 훑으면 이미 지나간 앞부분을
    // 다 번역한 뒤에야 화면의 한국어가 나온다 — 사용자에게는 "안 뜨는" 것과 같다.
    const now = adapter.getCurrentTime();
    const startIndex = typeof now === 'number' ? firstCueAtOrAfter(cues, now) : 0;

    const missing = [];
    for (let n = 0; n < cues.length; n++) {
      const i = (startIndex + n) % cues.length;
      if (!state.ko[i] && cues[i].text) missing.push(i);
    }
    if (!missing.length) {
      LFJP.log(`번역 준비 완료 — 공식 자막 ${state.ko.filter(Boolean).length}/${cues.length}줄`);
      return;
    }

    let cursor = 0;
    let size = FIRST_TRANSLATE_CHUNK;
    while (cursor < missing.length) {
      const batch = missing.slice(cursor, cursor + size);
      cursor += batch.length;
      size = TRANSLATE_CHUNK;

      const res = await LFJP.api.translate(batch.map((i) => cues[i].text));
      if (state.cues !== cues) return; // 그 사이 영상이 바뀌었다
      if (!res.ok) {
        if (!translateWarned) {
          translateWarned = true;
          LFJP.warn('번역을 사용할 수 없어 원문만 표시합니다 — ' + res.error);
        }
        return;
      }
      batch.forEach((cueIndex, resultIndex) => {
        state.ko[cueIndex] = (res.targets && res.targets[resultIndex]) || '';
      });
      LFJP.transcript.setTranslations(state.ko);
    }
    LFJP.log(`번역 완료 — ${state.ko.filter(Boolean).length}/${cues.length}줄`);
  }

  // ---------------------------------------------------------------- 형태소 분석
  //
  // 전체 cue 를 한 번에 분석하면 첫 자막까지의 지연이 커진다. 화면에 뜨는 cue 와
  // 바로 다음 몇 개만 요청하고, 짧게 모아서(debounce) 한 번의 배치로 보낸다.

  const PREFETCH = 3;
  const ANALYZE_DEBOUNCE_MS = 80;
  const ANALYZE_MAX_BATCH = 500;

  const requested = new Set(); // 이미 요청했거나 결과가 있는 cue index
  let queue = [];
  let flushTimer = null;

  function requestAnalysis(index) {
    const cues = state.cues;
    for (let i = index; i < Math.min(index + 1 + PREFETCH, cues.length); i++) {
      if (requested.has(i) || !cues[i] || !cues[i].text) continue;
      requested.add(i);
      queue.push(i);
    }
    if (queue.length && flushTimer === null) {
      flushTimer = setTimeout(flushAnalysis, ANALYZE_DEBOUNCE_MS);
    }
  }

  async function flushAnalysis() {
    flushTimer = null;
    const cues = state.cues;
    const batch = queue.slice(0, ANALYZE_MAX_BATCH);
    queue = queue.slice(batch.length);
    if (!batch.length) return;

    const res = await LFJP.api.analyze(batch.map((i) => cues[i].text));
    if (state.cues !== cues) return;

    if (!res.ok) {
      if (!analyzeWarned) {
        analyzeWarned = true;
        LFJP.warn('형태소 분석 실패 — 브라우저 단어 분리로 대체합니다: ' + res.error);
      }
      // 재시도 폭주를 막되 단어 클릭은 로컬 Segmenter로 계속 제공한다.
      batch.forEach((i) => {
        const tokens = LFJP.fallbackTokens(cues[i].text);
        state.tokens.set(i, tokens);
        LFJP.transcript.setTokens(i, tokens);
      });
      return;
    }

    // 응답의 results 는 요청한 texts 와 1:1 순서 보존이다.
    batch.forEach((cueIndex, i) => {
      const r = res.results[i];
      const tokens = (r && r.tokens && r.tokens.length)
        ? r.tokens
        : LFJP.fallbackTokens(cues[cueIndex].text);
      state.tokens.set(cueIndex, tokens);
      LFJP.transcript.setTokens(cueIndex, tokens);
    });

    if (queue.length && flushTimer === null) {
      flushTimer = setTimeout(flushAnalysis, ANALYZE_DEBOUNCE_MS);
    }
  }

  // ---------------------------------------------------------------- 렌더 루프

  function startLoop() {
    stopLoop();
    const tick = () => {
      rafId = requestAnimationFrame(tick);

      // 토글이 먼저다. 어댑터는 이 값을 보고 학습용 DOM 을 붙일지 걷을지 정하므로,
      // 패널·오버레이를 만들기 전에 현재 상태를 알려줘야 OFF 인데 한 프레임 붙었다
      // 떨어지는 깜빡임이 없다.
      if (adapter.ensureLearningToggle) {
        adapter.ensureLearningToggle(learningVisible, () => setLearningVisible(!learningVisible));
      }

      // OFF 면 학습용 DOM 을 아예 손대지 않는다. 여기서 ensure 를 계속 부르면
      // 어댑터가 매 프레임 무대 클래스를 다시 붙여, 껐는데도 사이트 레이아웃이
      // 원래대로 돌아오지 않는다.
      if (!learningVisible) {
        LFJP.overlay.hide();
        if (adapter.getPanelMount) adapter.getPanelMount();
        return;
      }

      // 패널은 오버레이와 독립이다. 플레이어를 못 찾아 오버레이가 실패해도
      // 대본은 계속 따라가야 한다.
      if (adapter.getPanelMount) LFJP.transcript.ensure(adapter.getPanelMount());
      if (adapter.getMountPoint) LFJP.overlay.ensure(adapter.getMountPoint());

      // 배속·seek·버퍼링에 관계없이 항상 현재 재생 시각을 기준으로 다시 계산한다.
      const t = adapter.getCurrentTime();
      if (t === null || t === undefined) return;

      const idx = LFJP.findCueIndex(state.cues, t);
      if (idx < 0) {
        activeCueIndex = -1;
        LFJP.overlay.hide();
        return;
      }
      activeCueIndex = idx;

      // 패널을 숨겨둔 동안에도 계속 돈다 — 다시 켰을 때 현재 위치가 맞아 있어야 한다.
      requestAnalysis(idx);
      LFJP.transcript.setCurrent(idx);
      const cue = state.cues[idx];
      LFJP.overlay.render({
        key: idx,
        text: cue.text,
        ko: state.ko[idx] || '',
        tokens: state.tokens.get(idx) || null
      });
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  /**
   * 대사 데이터만 비우고 패널과 루프는 살려둔다.
   *
   * 패널을 없애버리면 자막이 없는 영상에서 사용자는 확장이 죽은 건지 자막이 없는
   * 건지 알 수 없고, Option+J 로 켜고 끌 대상조차 사라진다.
   */
  function resetContent(status) {
    if (LFJP.shadowing) LFJP.shadowing.reset();
    LFJP.overlay.hide();
    state.cues = [];
    state.ko = [];
    state.tokens.clear();
    requested.clear();
    activeCueIndex = -1;
    queue = [];
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    translateWarned = false;
    analyzeWarned = false;
    LFJP.transcript.setStatus(status);
  }

  // ---------------------------------------------------------------- 배선

  LFJP.shadowing.init({
    adapter,
    getCues: () => state.cues,
    getMeta: () => adapter.getContentMeta()
  });

  /** 단어를 눌렀을 때 뜻풀이 + 저장 툴팁을 연다. 오버레이와 패널이 공유한다. */
  function openWordTooltip(token, cueText, span, mountEl, timeSec) {
    const meta = adapter.getContentMeta();
    LFJP.tooltip.open(span, mountEl, token, cueText, {
      platform: meta.platform,
      content_id: meta.contentId,
      title: meta.title,
      time_sec: timeSec
    });
  }

  LFJP.overlay.init({
    onWordClick(token, cueText, span, mountEl) {
      openWordTooltip(token, cueText, span, mountEl, adapter.getCurrentTime() || 0);
    },
    onPrevious: previousCue,
    onReplay: replayCue,
    onNext: nextCue
  });

  LFJP.transcript.init({
    onSeek(seconds) {
      if (adapter.seekTo) adapter.seekTo(seconds);
    },
    onOpenShadowing(container) {
      LFJP.shadowing.open(container);
    },
    onCloseShadowing() {
      LFJP.shadowing.pause();
    },
    onSaveSentence(cue, translation) {
      const meta = adapter.getContentMeta();
      return LFJP.api.saveExpression({
        kind: 'sentence',
        surface: cue.text,
        gloss: translation || '',
        source: {
          platform: meta.platform,
          content_id: meta.contentId,
          title: meta.title,
          time_sec: cue.start
        }
      });
    },
    // 패널에서 저장한 표현의 출처 시각은 "지금 재생 위치" 가 아니라 그 줄의 시각이다.
    onWordClick(token, cue, span, panelEl) {
      openWordTooltip(
        token,
        cue.text,
        span,
        adapter.getMountPoint ? (adapter.getMountPoint() || panelEl) : panelEl,
        cue.start
      );
    }
  });

  adapter.attach({
    onCues({ contentId, cues, meta, translations }) {
      resetContent('자막을 준비하는 중…');
      state.cues = cues;
      LFJP.transcript.render(cues, contentId);
      // NLP 응답을 기다리지 않고 모든 대사를 즉시 클릭 가능하게 만든다.
      // 화면 근처 cue는 이후 Sudachi 결과가 도착하면 읽기·품사 정보로 교체된다.
      cues.forEach((cue, index) => {
        const tokens = LFJP.fallbackTokens(cue.text);
        state.tokens.set(index, tokens);
        LFJP.transcript.setTokens(index, tokens);
      });
      if (LFJP.shadowing.available) LFJP.shadowing.available();
      LFJP.log(`자막 로드 완료 — ${cues.length}줄 (${adapter.platform}:${contentId})`, meta || {});
      loadTranslations(cues, translations);
    },
    onUnavailable(info) {
      // 어떤 트랙이 있었는지 펼쳐서 보여준다. 배열째로 넘기면 콘솔에서 접혀 있어
      // "왜 일본어가 없다는 거지" 를 확인하려면 매번 눌러 펴야 한다.
      if (info && info.needsCC) {
        const msg =
          '학습 언어 자막 트랙을 확인했습니다. 플레이어에 자막을 켜달라고 요청하는 중입니다 — ' +
          '잠시 뒤에도 자막이 안 뜨면 플레이어에서 직접 자막(CC)을 켜주세요.';
        LFJP.log(msg);
        LFJP.transcript.setStatus(msg);
        return;
      }

      const codes = (info && info.available) || [];
      const msg = codes.length
        ? `설정한 학습 언어 자막 트랙이 없습니다. 이 영상에 있는 트랙: ${codes.join(', ')} — ` +
          '화면에 자막이 보이더라도 유튜브가 다른 언어를 자동 번역해 보여주는 것이면 ' +
          '원본 트랙이 아니라 가져올 수 없습니다. 설정한 언어로 말하는 영상을 골라주세요.'
        : '이 영상에는 자막 트랙이 아예 없습니다 (화면에 보이는 자막은 영상에 새겨진 것일 수 있습니다).';
      LFJP.log(msg);
      resetContent(msg);
    },
    onError(err) {
      LFJP.warn('자막 취득 실패:', err.message);
      LFJP.transcript.setStatus('자막을 가져오지 못했습니다: ' + err.message);
    },
    onNavigate() {
      resetContent('자막을 기다리는 중…');
    }
  });

  // 패널은 자막과 무관하게 시청 페이지에 들어온 순간부터 떠 있어야 한다.
  // 그래야 자막이 없는 영상에서도 상태가 보이고 Option+J 로 껐다 켤 수 있다.
  LFJP.transcript.setStatus('자막을 기다리는 중…');
  startLoop();

  // Alt+J (macOS 는 Option+J) : 이중자막 표시 토글
  //
  // e.key 로 보면 안 된다 — macOS 에서 Option 은 문자를 바꿔치기해서 Option+J 가
  // 'j' 가 아니라 '∆' 로 들어온다. e.code 는 물리 키를 그대로 주므로 OS·자판 배열과
  // 무관하게 동작한다.
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyJ') {
      const next = !learningVisible;
      setLearningVisible(next);
      LFJP.log('대사 패널', next ? 'ON' : 'OFF');
      return;
    }

    const target = e.target;
    if (!learningVisible || e.altKey || e.ctrlKey || e.metaKey ||
        (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const actions = { KeyA: previousCue, KeyS: replayCue, KeyD: nextCue };
    const action = actions[e.code];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  });

  // 자막 밖을 누르면 툴팁을 닫는다.
  // 캡처 단계라 툴팁 자신의 버튼보다 먼저 도는 탓에, 툴팁/단어 내부 클릭은 제외해야
  // 저장 버튼이 눌리기도 전에 툴팁이 사라지는 일을 막을 수 있다.
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target;
      if (t && t.closest && t.closest('.lfjp-tooltip, .lfjp-word')) return;
      LFJP.tooltip.close();
    },
    true
  );
})();
