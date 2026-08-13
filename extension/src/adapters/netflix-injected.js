/**
 * NetflixAdapter의 페이지 컨텍스트 절반.
 *
 * Netflix 플레이어가 이미 요청하는 TTML/WebVTT 응답을 복제해 cue로 정규화한다.
 * 영상/DRM에는 접근하지 않고 자막 텍스트 응답만 읽는다.
 */
(() => {
  'use strict';

  if (window.__lfjpNetflixInjected) return;
  window.__lfjpNetflixInjected = true;

  const CHANNEL = 'LANGFLIX_JP';
  const post = (type, payload) =>
    window.postMessage({ __langflix: CHANNEL, type, payload }, '*');

  let sourceLang = 'ja';
  let currentContentId = contentIdFromLocation();
  const trackCache = new Map();
  const handled = new Set();

  function debug(msg, data) {
    post('NETFLIX_DEBUG', { msg, data });
  }

  function contentIdFromLocation() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : '';
  }

  function normalizeLang(value) {
    const lang = String(value || '').toLowerCase().replace('_', '-');
    if (lang.startsWith('ja')) return 'ja';
    if (lang.startsWith('ko')) return 'ko';
    return lang.split('-')[0];
  }

  function inferLang(text) {
    let ja = 0;
    let ko = 0;
    for (const char of text) {
      const cp = char.codePointAt(0);
      if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff)) ja++;
      if (cp >= 0xac00 && cp <= 0xd7a3) ko++;
    }
    if (ja === 0 && ko === 0) return '';
    return ja >= ko ? 'ja' : 'ko';
  }

  function parseClock(raw, tickRate, frameRate) {
    const value = String(raw || '').trim();
    if (!value) return 0;
    if (value.endsWith('ms')) return Number(value.slice(0, -2)) / 1000;
    if (value.endsWith('s')) return Number(value.slice(0, -1));
    if (value.endsWith('m')) return Number(value.slice(0, -1)) * 60;
    if (value.endsWith('h')) return Number(value.slice(0, -1)) * 3600;
    if (value.endsWith('t')) return Number(value.slice(0, -1)) / (tickRate || 1);
    if (value.endsWith('f')) return Number(value.slice(0, -1)) / (frameRate || 30);

    const parts = value.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return 0;
    if (parts.length === 4) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / (frameRate || 30);
    }
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return Number(value) || 0;
  }

  function cleanText(text) {
    return String(text || '')
      .replace(/\u200b/g, '')
      .replace(/[ \t]*\n[ \t]*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function parseTTML(raw) {
    const doc = new DOMParser().parseFromString(raw, 'application/xml');
    if (doc.querySelector('parsererror')) return null;
    const root = doc.documentElement;
    const tickRate = Number(
      root.getAttribute('ttp:tickRate') ||
      root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'tickRate') ||
      1
    );
    const frameRate = Number(
      root.getAttribute('ttp:frameRate') ||
      root.getAttributeNS('http://www.w3.org/ns/ttml#parameter', 'frameRate') ||
      30
    );
    let lang = normalizeLang(
      root.getAttribute('xml:lang') ||
      root.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') ||
      root.getAttribute('lang')
    );
    const cues = [];
    doc.querySelectorAll('p').forEach((node) => {
      const start = parseClock(node.getAttribute('begin'), tickRate, frameRate);
      let end = parseClock(node.getAttribute('end'), tickRate, frameRate);
      if (!end) end = start + parseClock(node.getAttribute('dur'), tickRate, frameRate);
      const text = cleanText(node.textContent);
      if (text && end > start) cues.push({ start, end, text });
    });
    if (!lang) lang = inferLang(cues.map((cue) => cue.text).join(''));
    return cues.length ? { lang, cues } : null;
  }

  function parseVTT(raw) {
    if (!String(raw).trimStart().startsWith('WEBVTT')) return null;
    const cues = [];
    const blocks = String(raw).replace(/\r/g, '').split(/\n{2,}/);
    const clock = (value) => {
      const clean = value.trim().split(/\s+/)[0];
      const parts = clean.split(':').map(Number);
      if (parts.some((part) => !Number.isFinite(part))) return 0;
      return parts.length === 3
        ? parts[0] * 3600 + parts[1] * 60 + parts[2]
        : parts[0] * 60 + parts[1];
    };
    for (const block of blocks) {
      const lines = block.split('\n');
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex < 0) continue;
      const [from, to] = lines[timingIndex].split('-->');
      const start = clock(from);
      const end = clock(to);
      const text = cleanText(
        lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '')
      );
      if (text && end > start) cues.push({ start, end, text });
    }
    return cues.length
      ? { lang: inferLang(cues.map((cue) => cue.text).join('')), cues }
      : null;
  }

  function normalizeCues(cues) {
    const sorted = cues
      .filter((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
      .sort((a, b) => a.start - b.start);
    const out = [];
    for (const cue of sorted) {
      const previous = out[out.length - 1];
      if (previous && previous.start === cue.start && previous.end === cue.end && previous.text === cue.text) {
        continue;
      }
      out.push(cue);
    }
    return out;
  }

  function emitTrack(contentId, lang, cues, via) {
    const normalizedLang = normalizeLang(lang);
    if (!contentId || !normalizedLang || !cues.length) return;
    const payload = {
      contentId,
      title: document.title,
      cues: normalizeCues(cues),
      meta: { lang: normalizedLang, via }
    };
    trackCache.set(`${contentId}|${normalizedLang}`, payload);
    if (normalizedLang === sourceLang && contentId === contentIdFromLocation()) {
      post('NETFLIX_CUES', payload);
    }
  }

  function handleSubtitle(url, body, via) {
    const raw = String(body || '').trim();
    if (!raw || (!raw.startsWith('<') && !raw.startsWith('WEBVTT'))) return;
    const contentId = contentIdFromLocation();
    const signature = `${contentId}|${url}|${raw.length}|${raw.slice(0, 40)}`;
    if (handled.has(signature)) return;

    try {
      const parsed = raw.startsWith('WEBVTT') ? parseVTT(raw) : parseTTML(raw);
      if (!parsed || !parsed.cues.length) return;
      handled.add(signature);
      // 일부 Netflix TTML은 언어 메타데이터를 생략한다. 이 경우 사용자가
      // 플레이어에서 학습 언어 자막을 선택했다는 전제로 현재 설정을 사용한다.
      const lang = parsed.lang || sourceLang;
      emitTrack(contentId, lang, parsed.cues, via);
      debug('자막 응답 포착', {
        contentId,
        lang,
        cues: parsed.cues.length,
        via
      });
    } catch (err) {
      post('NETFLIX_ERROR', { message: 'Netflix 자막 해석 실패: ' + String(err) });
    }
  }

  function isSubtitleResponse(url, contentType) {
    return /ttml|webvtt|text\/vtt|application\/xml|text\/xml/i.test(contentType || '') ||
      /timedtext|subtitle|\.ttml|\.vtt|\.xml/i.test(url || '');
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    promise.then((response) => {
      try {
        const url = response.url || String(args[0] || '');
        const contentType = response.headers.get('content-type') || '';
        if (!isSubtitleResponse(url, contentType)) return;
        response.clone().text().then((body) => handleSubtitle(url, body, 'fetch')).catch(() => {});
      } catch (_) {
        /* 원래 Netflix 요청에는 영향을 주지 않는다 */
      }
    }).catch(() => {});
    return promise;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__lfjpNetflixURL = String(url || '');
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        const contentType = this.getResponseHeader('content-type') || '';
        if (!isSubtitleResponse(this.__lfjpNetflixURL, contentType)) return;
        if (this.responseType && this.responseType !== 'text') return;
        handleSubtitle(this.__lfjpNetflixURL, this.responseText, 'xhr');
      } catch (_) {
        /* 자막 후보가 아니거나 읽을 수 없는 응답 */
      }
    });
    return originalSend.apply(this, args);
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || !data || data.__langflix !== CHANNEL || data.type !== 'NETFLIX_CONFIG') {
      return;
    }
    const next = data.payload && data.payload.sourceLang;
    if (next === 'ja' || next === 'ko') sourceLang = next;
    const cached = trackCache.get(`${contentIdFromLocation()}|${sourceLang}`);
    if (cached) post('NETFLIX_CUES', cached);
  });

  setInterval(() => {
    const next = contentIdFromLocation();
    if (next === currentContentId) return;
    currentContentId = next;
    post('NETFLIX_NAVIGATE', { contentId: next });
    const cached = trackCache.get(`${next}|${sourceLang}`);
    if (cached) post('NETFLIX_CUES', cached);
  }, 500);

  debug('Netflix 자막 감시 시작', { sourceLang });
})();
