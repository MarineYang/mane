/**
 * 무마이크 쉐도잉 학습 화면.
 *
 * 발음 채점보다 먼저 학습 루프를 검증한다:
 * 듣기 → 반복/오버랩 → 자막 없이 말하기 → 자기평가 → 복습 예약.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  const STAGES = ['원음 듣기', '반복·오버랩', '자막 없이 말하기', '기록'];

  let adapter = null;
  let getCues = () => [];
  let getMeta = () => ({});
  let container = null;
  let sentences = [];
  let current = 0;
  let loading = false;
  let settings = { sourceLang: 'ja', targetLang: 'ko' };
  let playGeneration = 0;
  let loopEnabled = false;
  let revealed = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function mediaElement() {
    return adapter && adapter.getMediaElement ? adapter.getMediaElement() : null;
  }

  function stopOriginal() {
    playGeneration++;
    loopEnabled = false;
    const media = mediaElement();
    if (media) media.pause();
  }

  async function playSegment(sentence, repeat) {
    const media = mediaElement();
    if (!media) throw new Error('재생 중인 영상을 찾지 못했습니다.');
    const generation = ++playGeneration;
    loopEnabled = Boolean(repeat);

    const once = async () => {
      if (generation !== playGeneration) return;
      media.currentTime = Math.max(0, sentence.start - 0.08);
      await media.play();
      await new Promise((resolve) => {
        const tick = () => {
          if (generation !== playGeneration || media.currentTime >= sentence.end) {
            media.pause();
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      if (loopEnabled && generation === playGeneration) setTimeout(once, 450);
    };
    return once();
  }

  function stageOf(sentence) {
    return Math.max(0, Math.min(STAGES.length - 1, sentence.stage || 0));
  }

  function renderStageBar(card, sentence) {
    const bar = el('div', 'lfjp-shadow-stages');
    const active = stageOf(sentence);
    STAGES.forEach((name, index) => {
      const item = el('span', 'lfjp-shadow-stage', `${index + 1}. ${name}`);
      item.classList.toggle('on', index === active);
      item.classList.toggle('done', index < active);
      bar.appendChild(item);
    });
    card.appendChild(bar);
  }

  function appendText(card, sentence, hidden) {
    const text = el('div', 'lfjp-shadow-text', hidden && !revealed ? '••••••••' : sentence.text);
    if (hidden && !revealed) text.classList.add('hidden');
    card.appendChild(text);
    if ((!hidden || revealed) && sentence.translation) {
      card.appendChild(el('div', 'lfjp-shadow-translation', sentence.translation));
    }
  }

  function actionButton(label, handler, className) {
    const button = el('button', className || '', label);
    button.addEventListener('click', handler);
    return button;
  }

  function playWithStatus(sentence, repeat, status) {
    playSegment(sentence, repeat).catch((err) => {
      status.textContent = err.message;
    });
  }

  function renderListen(card, sentence, status) {
    appendText(card, sentence, false);
    card.appendChild(
      el('div', 'lfjp-shadow-guide', '먼저 자막을 보며 원음의 속도와 호흡을 확인하세요.')
    );
    const actions = el('div', 'lfjp-shadow-actions');
    actions.append(
      actionButton('▶ 원음 듣기', () => playWithStatus(sentence, false, status)),
      actionButton('다음 단계', () => advanceStage(sentence), 'primary')
    );
    card.appendChild(actions);
  }

  function renderOverlap(card, sentence, status) {
    appendText(card, sentence, false);
    card.appendChild(
      el(
        'div',
        'lfjp-shadow-guide',
        '첫 반복은 원음 뒤에 따라 하고, 익숙해지면 원음과 동시에 겹쳐 말해보세요.'
      )
    );
    const actions = el('div', 'lfjp-shadow-actions');
    const loop = actionButton(loopEnabled ? '■ 반복 끝내기' : '↻ 구간 반복', () => {
      if (loopEnabled) {
        stopOriginal();
        loop.textContent = '↻ 구간 반복';
      } else {
        loop.textContent = '■ 반복 끝내기';
        playWithStatus(sentence, true, status);
      }
    });
    actions.append(
      loop,
      actionButton('자막 없이 해보기', () => advanceStage(sentence), 'primary')
    );
    card.appendChild(actions);
  }

  function renderBlind(card, sentence, status) {
    appendText(card, sentence, true);
    card.appendChild(
      el(
        'div',
        'lfjp-shadow-guide',
        '자막을 보지 않고 먼저 말한 뒤 원음을 재생해 차이를 스스로 확인하세요.'
      )
    );
    const actions = el('div', 'lfjp-shadow-actions');
    actions.append(
      actionButton('▶ 말한 뒤 원음 확인', () => playWithStatus(sentence, false, status)),
      actionButton(revealed ? '자막 다시 숨기기' : '자막 확인', () => {
        revealed = !revealed;
        renderExercise();
      }),
      actionButton('말해봤어요', () => advanceStage(sentence), 'primary')
    );
    card.appendChild(actions);
  }

  function renderRating(card, sentence, status) {
    appendText(card, sentence, false);
    card.appendChild(
      el('div', 'lfjp-shadow-guide', '방금 말한 느낌을 기록하면 다음 복습 시점을 정합니다.')
    );
    const actions = el('div', 'lfjp-shadow-rating');
    actions.append(
      actionButton('어려웠어요', () => saveRating(sentence, 'hard', status)),
      actionButton('비슷하게 말했어요', () => saveRating(sentence, 'good', status), 'primary'),
      actionButton('자연스러웠어요', () => saveRating(sentence, 'easy', status))
    );
    card.appendChild(actions);
  }

  function renderSaved(card, sentence) {
    if (!sentence.attempt) return;
    const box = el('div', 'lfjp-shadow-result');
    const label = {
      hard: '어려움',
      good: '익히는 중',
      easy: '자연스러움'
    }[sentence.attempt.self_rating] || '기록됨';
    box.appendChild(el('strong', '', label));
    if (sentence.attempt.due_at) {
      const due = new Date(sentence.attempt.due_at);
      box.appendChild(
        el('div', 'lfjp-shadow-status', `다음 복습: ${due.toLocaleDateString()} ${due.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
      );
    }
    (sentence.attempt.practice_hints || []).forEach((hint) => {
      box.appendChild(el('div', 'lfjp-shadow-hint', hint));
    });
    card.appendChild(box);
  }

  function advanceStage(sentence) {
    stopOriginal();
    sentence.stage = Math.min(3, stageOf(sentence) + 1);
    revealed = false;
    renderExercise();
  }

  async function saveRating(sentence, rating, status) {
    if (sentence.saving) return;
    sentence.saving = true;
    status.textContent = '복습 일정을 저장하는 중…';
    const meta = getMeta() || {};
    const source = sentence.source || {
      platform: meta.platform || 'youtube',
      content_id: meta.contentId || '',
      title: meta.title || '',
      time_sec: sentence.start
    };
    const res = await LFJP.api.saveShadowingAttempt({
      source_lang: settings.sourceLang,
      target_lang: settings.targetLang,
      text: sentence.text,
      translation: sentence.translation || '',
      review_of: sentence.reviewId || '',
      self_rating: rating,
      start: sentence.start,
      end: sentence.end,
      source
    });
    sentence.saving = false;
    if (!res.ok) {
      status.textContent = '저장하지 못했습니다: ' + res.error;
      return;
    }
    sentence.attempt = res.attempt;
    if (sentence.reviewId) {
      await LFJP.api.completeShadowingReview(sentence.reviewId, res.attempt.score);
    }
    renderExercise();
  }

  function renderExercise() {
    if (!container) return;
    container.textContent = '';
    if (!sentences.length) {
      container.appendChild(el('div', 'lfjp-status', '연습 세트를 먼저 만들어주세요.'));
      renderStartActions();
      return;
    }

    const sentence = sentences[current];
    const progress = el('div', 'lfjp-shadow-progress', `${current + 1} / ${sentences.length}`);
    const card = el('div', 'lfjp-shadow-card');
    renderStageBar(card, sentence);
    const status = el('div', 'lfjp-shadow-status', '');

    if (sentence.attempt) {
      appendText(card, sentence, false);
      renderSaved(card, sentence);
    } else {
      switch (stageOf(sentence)) {
        case 0:
          renderListen(card, sentence, status);
          break;
        case 1:
          renderOverlap(card, sentence, status);
          break;
        case 2:
          renderBlind(card, sentence, status);
          break;
        default:
          renderRating(card, sentence, status);
      }
    }
    card.appendChild(status);

    const nav = el('div', 'lfjp-shadow-nav');
    const prev = actionButton('이전', () => move(-1));
    prev.disabled = current === 0;
    const next = actionButton(current === sentences.length - 1 ? '세트 마치기' : '다음 문장', () => {
      if (current === sentences.length - 1) renderComplete();
      else move(1);
    }, 'primary');
    next.disabled = !sentence.attempt;
    nav.append(prev, next);
    container.append(progress, card, nav);
  }

  function move(delta) {
    stopOriginal();
    revealed = false;
    current = Math.max(0, Math.min(sentences.length - 1, current + delta));
    renderExercise();
  }

  function renderComplete() {
    stopOriginal();
    const completed = sentences.filter((sentence) => sentence.attempt).length;
    container.textContent = '';
    container.appendChild(
      el('div', 'lfjp-shadow-complete', `세트 완료 · ${completed}/${sentences.length}문장`)
    );
    renderStartActions();
  }

  function renderStartActions() {
    const actions = el('div', 'lfjp-shadow-start');
    actions.append(
      actionButton('이 영상에서 8문장 연습', loadSet, 'primary'),
      actionButton('이 영상의 오늘 복습', loadReviews)
    );
    container.appendChild(actions);
  }

  async function loadSet() {
    if (loading) return;
    const cues = getCues();
    if (!cues.length) {
      container.textContent = '';
      container.appendChild(el('div', 'lfjp-status', '자막을 불러온 뒤 연습 세트를 만들 수 있습니다.'));
      return;
    }
    loading = true;
    container.textContent = '';
    container.appendChild(el('div', 'lfjp-status', '영상에서 연습하기 좋은 문장을 고르는 중…'));
    const [set, config] = await Promise.all([LFJP.api.shadowingSet(cues, 8), LFJP.api.settings()]);
    if (config.ok) settings = config;
    if (!set.ok) {
      loading = false;
      container.textContent = '';
      container.appendChild(el('div', 'lfjp-status', '세트를 만들지 못했습니다: ' + set.error));
      renderStartActions();
      return;
    }
    sentences = (set.sentences || []).map((sentence) => ({ ...sentence, stage: 0 }));
    const translated = sentences.length
      ? await LFJP.api.translate(sentences.map((sentence) => sentence.text))
      : { ok: true, targets: [] };
    if (translated.ok) {
      sentences.forEach((sentence, index) => {
        sentence.translation = translated.targets[index] || '';
      });
    }
    current = 0;
    loading = false;
    renderExercise();
  }

  async function loadReviews() {
    if (loading) return;
    loading = true;
    container.textContent = '';
    container.appendChild(el('div', 'lfjp-status', '복습할 문장을 확인하는 중…'));
    const [res, config] = await Promise.all([
      LFJP.api.listShadowingReviews(new Date().toISOString()),
      LFJP.api.settings()
    ]);
    if (config.ok) settings = config;
    loading = false;
    if (!res.ok) {
      container.textContent = '';
      container.appendChild(el('div', 'lfjp-status', '복습을 불러오지 못했습니다: ' + res.error));
      renderStartActions();
      return;
    }
    const meta = getMeta() || {};
    sentences = (res.reviews || [])
      .filter((attempt) => {
        const source = attempt.source || {};
        return !source.content_id || source.content_id === meta.contentId;
      })
      .map((attempt) => ({
        text: attempt.text,
        translation: attempt.translation,
        start: attempt.start,
        end: attempt.end,
        source: attempt.source,
        reviewId: attempt.id,
        stage: 2
      }));
    current = 0;
    if (!sentences.length) {
      container.textContent = '';
      container.appendChild(el('div', 'lfjp-status', '이 영상에서 오늘 복습할 문장이 없습니다.'));
      renderStartActions();
      return;
    }
    renderExercise();
  }

  function open(nextContainer) {
    if (container !== nextContainer) {
      container = nextContainer;
      sentences = [];
      current = 0;
    }
    if (!container.childNodes.length) {
      container.appendChild(
        el('div', 'lfjp-status', '마이크 없이 듣기·반복·자기평가로 쉐도잉 루프를 연습합니다.')
      );
      renderStartActions();
    }
  }

  function reset() {
    stopOriginal();
    sentences = [];
    current = 0;
    revealed = false;
    if (container) container.textContent = '';
  }

  LFJP.shadowing = {
    init(opts) {
      adapter = opts.adapter;
      getCues = opts.getCues;
      getMeta = opts.getMeta;
    },
    open,
    available() {
      if (container && !container.childNodes.length) open(container);
    },
    pause: stopOriginal,
    reset
  };
})();
