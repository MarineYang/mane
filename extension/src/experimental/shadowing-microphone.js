/**
 * 보류된 마이크 쉐도잉 실험 화면. 현재 manifest에서는 로드하지 않는다.
 *
 * 영상 전체를 그대로 연습시키지 않고 백엔드가 고른 8문장만 완주하게 한다.
 * 원음 구간 재생 → 마이크 녹음 → 내 음성 재생 → 기본 채점의 한 화면 루프다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  let adapter = null;
  let getCues = () => [];
  let getMeta = () => ({});
  let container = null;
  let sentences = [];
  let current = 0;
  let loading = false;
  let settings = {
    sourceLang: 'ja',
    targetLang: 'ko',
    speechRecognitionEnabled: false
  };

  let playGeneration = 0;
  let loopEnabled = false;
  let mediaRecorder = null;
  let recordingStream = null;
  let recordingTimer = null;
  let recognition = null;
  let recognizedText = '';
  let audioURL = '';
  let signalSampler = null;
  let recordingGeneration = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stopOriginal() {
    playGeneration++;
    loopEnabled = false;
    const media = adapter && adapter.getMediaElement && adapter.getMediaElement();
    if (media) media.pause();
  }

  async function playSegment(sentence, repeat) {
    const media = adapter && adapter.getMediaElement && adapter.getMediaElement();
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
      if (loopEnabled && generation === playGeneration) {
        setTimeout(once, 350);
      }
    };
    return once();
  }

  function makeSignalSampler(stream) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return { stop: () => ({ onsetSec: 0, speechRatio: 0 }) };

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    const started = performance.now();
    const frames = [];
    let raf = 0;

    const sample = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (const value of data) sum += value * value;
      frames.push({ at: (performance.now() - started) / 1000, rms: Math.sqrt(sum / data.length) });
      raf = requestAnimationFrame(sample);
    };
    sample();

    return {
      stop() {
        cancelAnimationFrame(raf);
        source.disconnect();
        ctx.close().catch(() => {});
        // 일반 실내 마이크의 무음 RMS보다 충분히 높되 작은 목소리도 놓치지 않는 값.
        const threshold = 0.018;
        const voiced = frames.filter((frame) => frame.rms >= threshold);
        return {
          onsetSec: voiced.length ? voiced[0].at : 0,
          speechRatio: frames.length ? voiced.length / frames.length : 0
        };
      }
    };
  }

  function startRecognition() {
    if (!settings.speechRecognitionEnabled) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    try {
      recognition = new SpeechRecognition();
      recognition.lang = settings.sourceLang === 'ko' ? 'ko-KR' : 'ja-JP';
      recognition.interimResults = false;
      recognition.continuous = true;
      recognition.onresult = (event) => {
        const parts = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) parts.push(event.results[i][0].transcript);
        }
        if (parts.length) recognizedText += parts.join('');
      };
      recognition.onerror = () => {
        recognition = null;
      };
      recognition.start();
    } catch (_) {
      recognition = null;
    }
  }

  function stopRecognition() {
    const active = recognition;
    if (!active) return Promise.resolve();
    recognition = null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      active.onend = finish;
      setTimeout(finish, 400);
      try {
        // stop() 뒤 최종 result가 onend 전에 올 수 있어 그때까지 기다린다.
        active.stop();
      } catch (_) {
        finish();
      }
    });
  }

  async function startRecording(sentence, button, status) {
    if (mediaRecorder && mediaRecorder.state === 'recording') return;
    stopOriginal();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      status.textContent = '이 브라우저에서는 마이크 녹음을 사용할 수 없습니다.';
      return;
    }

    try {
      recordingStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (err) {
      status.textContent = '마이크 권한이 필요합니다: ' + err.message;
      return;
    }

    const generation = ++recordingGeneration;
    const chunks = [];
    const startedAt = performance.now();
    recognizedText = '';
    const stream = recordingStream;
    const sampler = makeSignalSampler(stream);
    signalSampler = sampler;
    startRecognition();

    const preferred = ['audio/webm;codecs=opus', 'audio/webm'].find((type) =>
      MediaRecorder.isTypeSupported(type)
    );
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    mediaRecorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      clearTimeout(recordingTimer);
      const endedAt = performance.now();
      const signal = sampler.stop();
      if (signalSampler === sampler) signalSampler = null;
      stream.getTracks().forEach((track) => track.stop());
      if (recordingStream === stream) recordingStream = null;
      await stopRecognition();

      const duration = Math.max(0.1, (endedAt - startedAt) / 1000);
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (mediaRecorder === recorder) mediaRecorder = null;
      if (generation !== recordingGeneration) return;
      if (audioURL) URL.revokeObjectURL(audioURL);
      audioURL = URL.createObjectURL(blob);
      await submitAttempt(sentence, duration, signal, status);
      if (generation !== recordingGeneration) return;
      renderExercise();
    };
    recorder.start(200);
    button.textContent = '■ 녹음 끝내기';
    button.classList.add('recording');
    status.textContent = '녹음 중… 원문을 보며 한 호흡으로 말하세요.';

    const maximum = Math.max(6000, (sentence.end - sentence.start + 4) * 1000);
    recordingTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, maximum);
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  }

  async function submitAttempt(sentence, recordingDuration, signal, status) {
    status.textContent = '발화를 분석하는 중…';
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
      start: sentence.start,
      end: sentence.end,
      source,
      metrics: {
        reference_duration: Math.max(0.1, sentence.end - sentence.start),
        recording_duration: recordingDuration,
        onset_sec: signal.onsetSec,
        speech_ratio: signal.speechRatio,
        recognized_text: recognizedText
      }
    });
    if (!res.ok) {
      sentence.error = res.error;
      return;
    }
    sentence.attempt = res.attempt;
    sentence.tries = (sentence.tries || 0) + 1;

    // 복습 카드로 들어온 문장은 새 시도의 점수로 기존 카드의 다음 간격도 갱신한다.
    if (sentence.reviewId) {
      await LFJP.api.completeShadowingReview(sentence.reviewId, res.attempt.score);
      sentence.reviewCompleted = true;
    }
  }

  function renderScore(card, sentence) {
    if (!sentence.attempt) {
      if (sentence.error) card.appendChild(el('div', 'lfjp-shadow-error', sentence.error));
      return;
    }
    const attempt = sentence.attempt;
    const result = el('div', 'lfjp-shadow-result');
    const score = el('div', 'lfjp-shadow-score', String(attempt.score));
    score.title = attempt.provisional ? '리듬 중심 임시 점수' : '음성 인식과 리듬을 합친 기본 점수';
    const detail = el(
      'div',
      'lfjp-shadow-breakdown',
      `${attempt.provisional ? '임시 점수 · ' : ''}타이밍 ${attempt.breakdown.timing} · 전달 ${attempt.breakdown.delivery}` +
        (attempt.breakdown.text_match === undefined ? '' : ` · 문장 ${attempt.breakdown.text_match}`)
    );
    result.append(score, detail);

    const messages = el('ul', 'lfjp-shadow-feedback');
    [...(attempt.feedback || []), ...(attempt.practice_hints || [])].forEach((message) => {
      messages.appendChild(el('li', '', message));
    });
    result.appendChild(messages);
    card.appendChild(result);
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
    card.appendChild(el('div', 'lfjp-shadow-text', sentence.text));
    if (sentence.translation) card.appendChild(el('div', 'lfjp-shadow-translation', sentence.translation));

    const actions = el('div', 'lfjp-shadow-actions');
    const listen = el('button', '', '▶ 원음 듣기');
    listen.addEventListener('click', () => {
      loopEnabled = false;
      playSegment(sentence, false).catch((err) => {
        status.textContent = err.message;
      });
    });
    const loop = el('button', '', loopEnabled ? '■ 반복 끝내기' : '↻ 구간 반복');
    loop.addEventListener('click', () => {
      if (loopEnabled) {
        stopOriginal();
        loop.textContent = '↻ 구간 반복';
      } else {
        loop.textContent = '■ 반복 끝내기';
        playSegment(sentence, true).catch((err) => {
          status.textContent = err.message;
        });
      }
    });
    const record = el('button', 'lfjp-shadow-record', '● 따라 말하기');
    record.addEventListener('click', () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
      else startRecording(sentence, record, status);
    });
    actions.append(listen, loop, record);
    card.appendChild(actions);

    const status = el('div', 'lfjp-shadow-status', '원음을 듣고, 준비되면 따라 말하기를 누르세요.');
    card.appendChild(status);

    if (audioURL) {
      const mine = el('div', 'lfjp-shadow-mine');
      mine.appendChild(el('span', '', '내 음성'));
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = audioURL;
      mine.appendChild(audio);
      card.appendChild(mine);
    }

    renderScore(card, sentence);

    const nav = el('div', 'lfjp-shadow-nav');
    const prev = el('button', '', '이전');
    prev.disabled = current === 0;
    prev.addEventListener('click', () => move(-1));
    const retry = el('button', '', `다시 녹음${sentence.tries ? ` (${sentence.tries})` : ''}`);
    retry.addEventListener('click', () => startRecording(sentence, record, status));
    const next = el('button', 'primary', current === sentences.length - 1 ? '완료' : '다음');
    next.addEventListener('click', () => {
      if (current === sentences.length - 1) renderComplete();
      else move(1);
    });
    nav.append(prev, retry, next);

    container.append(progress, card, nav);
  }

  function move(delta) {
    stopOriginal();
    recordingGeneration++;
    stopRecording();
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = '';
    current = Math.max(0, Math.min(sentences.length - 1, current + delta));
    renderExercise();
  }

  function renderComplete() {
    stopOriginal();
    container.textContent = '';
    const practiced = sentences.filter((sentence) => sentence.attempt);
    const average = practiced.length
      ? Math.round(practiced.reduce((sum, sentence) => sum + sentence.attempt.score, 0) / practiced.length)
      : 0;
    container.appendChild(el('div', 'lfjp-shadow-complete', `세트 완료 · ${practiced.length}/${sentences.length}문장 · 평균 ${average}점`));
    renderStartActions();
  }

  function renderStartActions() {
    const actions = el('div', 'lfjp-shadow-start');
    const fresh = el('button', 'primary', '이 영상에서 8문장 연습');
    fresh.addEventListener('click', loadSet);
    const review = el('button', '', '오늘의 복습');
    review.addEventListener('click', loadReviews);
    actions.append(fresh, review);
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
    sentences = (set.sentences || []).map((sentence) => ({ ...sentence }));
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
        reviewId: attempt.id
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
      container.appendChild(el('div', 'lfjp-status', '좋은 문장만 골라 듣고, 녹음하고, 바로 비교합니다.'));
      renderStartActions();
    }
  }

  function reset() {
    stopOriginal();
    recordingGeneration++;
    stopRecording();
    stopRecognition();
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = '';
    sentences = [];
    current = 0;
    if (container) container.textContent = '';
  }

  LFJP.shadowing = {
    init(opts) {
      adapter = opts.adapter;
      getCues = opts.getCues;
      getMeta = opts.getMeta;
    },
    open,
    pause: stopOriginal,
    reset
  };
})();
