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
  let targetLang = 'ko';
  let currentContentId = contentIdFromLocation();
  const trackCache = new Map();
  const handled = new Set();

  // 자막 트랙 자동 선택용 상태. originalTrack 은 학습 화면을 끌 때 되돌릴 사용자의
  // 원래 선택이다.
  let originalTrack = null;
  let switchedTrack = false;
  let trackScans = 0;
  let reportedUnavailable = false;

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

  function alignTranslations(sourceCues, targetCues) {
    const out = [];
    let cursor = 0;
    for (const source of sourceCues) {
      while (cursor < targetCues.length && targetCues[cursor].end <= source.start) cursor++;
      const parts = [];
      for (let i = cursor; i < targetCues.length && targetCues[i].start < source.end; i++) {
        const target = targetCues[i];
        const overlap = Math.min(source.end, target.end) - Math.max(source.start, target.start);
        if (overlap > 0.04 && !parts.includes(target.text)) parts.push(target.text);
      }
      out.push(parts.join(' '));
    }
    return out;
  }

  function emitCurrentTrack(contentId) {
    const source = trackCache.get(`${contentId}|${sourceLang}`);
    if (!source) return;
    const target = trackCache.get(`${contentId}|${targetLang}`);
    post('NETFLIX_CUES', {
      ...source,
      translations: target ? alignTranslations(source.cues, target.cues) : []
    });
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
    if (contentId === contentIdFromLocation() &&
        (normalizedLang === sourceLang || normalizedLang === targetLang)) {
      emitCurrentTrack(contentId);
    }
  }

  function handleSubtitle(url, body, via, forcedLang) {
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
      const lang = normalizeLang(forcedLang) || parsed.lang || sourceLang;
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

  function isManifestResponse(url, contentType) {
    // 일부 Netflix 클라이언트는 매니페스트를 JSON이 아닌 일반 바이너리/빈
    // Content-Type으로 표시한다. URL이 매니페스트임이 분명하면 본문을 한 번
    // JSON으로 시도하고, 실패는 discoverSubtitleTracks가 조용히 무시한다.
    return /manifest|playapi/i.test(url || '');
  }

  function firstDownloadURL(value, seen, depth) {
    if (depth > 8 || value === null || value === undefined) return '';
    if (typeof value === 'string') {
      // downloadableId 같은 일반 문자열을 현재 페이지 기준 상대 URL로 오인하지
      // 않는다. Netflix 자막 CDN 주소는 절대 URL 또는 // 형태다.
      if (!/^(?:https?:)?\/\//i.test(value)) return '';
      try {
        const url = new URL(value, location.href);
        return /^https?:$/.test(url.protocol) ? url.href : '';
      } catch (_) {
        return '';
      }
    }
    if (typeof value !== 'object') return '';
    if (seen.has(value)) return '';
    seen.add(value);

    // 최신 응답은 urls: [{url: "..."}] 형태, 기존 응답은
    // downloadUrls: {id: "..."} 형태다. 명시적인 URL 필드를 먼저 본다.
    for (const key of ['url', 'downloadUrl', 'downloadURL']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = firstDownloadURL(value[key], seen, depth + 1);
        if (found) return found;
      }
    }
    for (const child of Object.values(value)) {
      const found = firstDownloadURL(child, seen, depth + 1);
      if (found) return found;
    }
    return '';
  }

  function downloadableURL(track) {
    const root = track && (track.ttDownloadables || track.downloadables);
    if (!root || typeof root !== 'object') return '';
    const preferred = ['webvtt-lssdh-ios8', 'dfxp-ls-sdh', 'simplesdh'];
    const profiles = [
      ...preferred.map((name) => root[name]).filter(Boolean),
      ...Object.values(root)
    ];
    for (const profile of profiles) {
      const urls = profile && (profile.downloadUrls || profile.urls || profile);
      const found = firstDownloadURL(urls, new Set(), 0);
      if (found) return found;
    }
    return '';
  }

  function discoverSubtitleTracks(raw, via) {
    let json;
    try {
      json = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {
      return;
    }

    const found = [];
    const visit = (node, depth) => {
      if (!node || depth > 14) return;
      if (Array.isArray(node)) {
        node.forEach((value) => visit(value, depth + 1));
        return;
      }
      if (typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (/^(timedtexttracks|texttracks)$/i.test(key) && Array.isArray(value)) {
          value.forEach((track) => found.push(track));
        } else {
          visit(value, depth + 1);
        }
      }
    };
    visit(json, 0);

    const contentId = contentIdFromLocation();
    found.forEach((track) => {
      if (!track || track.isNoneTrack) return;
      const lang = normalizeLang(
        track.language || track.bcp47 || track.languageCode || track.lang || track.locale
      );
      if (lang !== sourceLang && lang !== targetLang) return;
      const url = downloadableURL(track);
      if (!url) return;
      const signature = `manifest-track|${contentId}|${lang}|${url}`;
      if (handled.has(signature)) return;
      handled.add(signature);
      originalFetch(url)
        .then((response) => response.text())
        .then((body) => handleSubtitle(url, body, `${via}:manifest`, lang))
        .catch(() => {});
    });
  }

  /** 현재 재생 세션의 Netflix 플레이어. 아직 준비 전이면 null. */
  function netflixPlayer() {
    try {
      const playerApp = window.netflix && window.netflix.appContext &&
        window.netflix.appContext.state && window.netflix.appContext.state.playerApp;
      const videoPlayer = playerApp && playerApp.getAPI && playerApp.getAPI().videoPlayer;
      const ids = videoPlayer && videoPlayer.getAllPlayerSessionIds &&
        videoPlayer.getAllPlayerSessionIds();
      if (!ids || !ids.length) return null;
      return videoPlayer.getVideoPlayerBySessionId(ids[0]) || null;
    } catch (_) {
      return null;
    }
  }

  function seekWithNetflixPlayer(seconds) {
    try {
      const player = netflixPlayer();
      if (!player || typeof player.seek !== 'function') throw new Error('Netflix player API를 찾지 못했습니다.');
      player.seek(Math.max(0, Number(seconds) || 0) * 1000);
    } catch (err) {
      post('NETFLIX_SEEK_UNAVAILABLE', { message: String(err && err.message ? err.message : err) });
    }
  }

  // ── 학습 언어 트랙 확보 ─────────────────────────────────────────────
  //
  // Netflix 는 "지금 선택된" 자막만 내려받는다. 사용자가 한국어를 켜두면 일본어
  // 트랙은 네트워크에 아예 뜨지 않으므로, 응답을 가로채는 것만으로는 영원히 잡을 수
  // 없다 — 매번 플레이어에서 일본어를 직접 골라야 했던 이유다.
  //
  // 그래서 플레이어의 트랙 목록을 직접 읽는다. 트랙 객체가 다운로드 주소를 들고
  // 있으면 그것만 받아오고(사용자의 자막 선택을 건드리지 않는다), 없으면 그 트랙을
  // 대신 골라 Netflix 가 내려받게 한다. 원래 선택은 기억해 두었다가 학습 화면을 끌
  // 때 되돌린다.

  function trackLang(track) {
    return normalizeLang(
      track && (track.bcp47 || track.language || track.languageCode || track.lang || track.locale)
    );
  }

  function listTracks(player) {
    try {
      const tracks = player.getTimedTextTrackList && player.getTimedTextTrackList();
      return Array.isArray(tracks) ? tracks.filter((track) => track && !track.isNoneTrack) : [];
    } catch (_) {
      return [];
    }
  }

  function ensureSourceTrack() {
    const contentId = contentIdFromLocation();
    if (!contentId) return;
    if (trackCache.has(`${contentId}|${sourceLang}`)) return; // 이미 확보했다

    const player = netflixPlayer();
    if (!player) return;
    const tracks = listTracks(player);
    if (!tracks.length) return;

    const wanted = tracks.find((track) => trackLang(track) === sourceLang);
    if (!wanted) {
      // 트랙 목록은 읽혔는데 학습 언어가 없다. 다만 목록은 재생 시작 직후 일부만
      // 채워져 있을 수 있어, 몇 초 지켜본 뒤에야 "없다"고 단정한다 — 잘못 알리면
      // 공통 레이어가 대사를 지워버린다.
      if (!reportedUnavailable && trackScans > 10) {
        reportedUnavailable = true;
        post('NETFLIX_UNAVAILABLE', {
          contentId,
          available: Array.from(new Set(tracks.map(trackLang).filter(Boolean)))
        });
      }
      return;
    }

    // 사용자의 선택을 건드리지 않는 길이 있으면 그쪽이 먼저다.
    const url = downloadableURL(wanted);
    if (url) {
      const signature = `player-track|${contentId}|${sourceLang}|${url}`;
      if (handled.has(signature)) return;
      handled.add(signature);
      originalFetch(url)
        .then((response) => response.text())
        .then((body) => handleSubtitle(url, body, 'player:downloadable', sourceLang))
        .catch(() => {});
      return;
    }

    if (switchedTrack) return;
    try {
      originalTrack = player.getTimedTextTrack ? player.getTimedTextTrack() : null;
      player.setTimedTextTrack(wanted);
      switchedTrack = true;
      debug('학습 언어 자막 트랙을 대신 선택했다', {
        contentId,
        lang: sourceLang,
        restoreTo: trackLang(originalTrack) || 'off'
      });
    } catch (err) {
      post('NETFLIX_ERROR', { message: '자막 트랙 선택 실패: ' + String(err) });
    }
  }

  /** 학습 화면을 끌 때 사용자의 원래 자막 선택으로 되돌린다. */
  function restoreOriginalTrack() {
    if (!switchedTrack) return;
    switchedTrack = false;
    const player = netflixPlayer();
    if (!player || !player.setTimedTextTrack) return;
    try {
      if (originalTrack) player.setTimedTextTrack(originalTrack);
    } catch (_) {
      /* 트랙이 사라졌거나 플레이어가 교체됐다 — 되돌릴 대상이 없다 */
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = originalFetch.apply(this, args);
    promise.then((response) => {
      try {
        const url = response.url || String(args[0] || '');
        const contentType = response.headers.get('content-type') || '';
        if (isManifestResponse(url, contentType)) {
          response.clone().text().then((body) => discoverSubtitleTracks(body, 'fetch')).catch(() => {});
        }
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
        if (isManifestResponse(this.__lfjpNetflixURL, contentType)) {
          const body = this.responseType === 'json' ? this.response : this.responseText;
          discoverSubtitleTracks(body, 'xhr');
        }
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
    if (event.source !== window || !data || data.__langflix !== CHANNEL) {
      return;
    }
    if (data.type === 'NETFLIX_SEEK') {
      seekWithNetflixPlayer(data.payload && data.payload.seconds);
      return;
    }
    if (data.type === 'NETFLIX_RESTORE_TRACK') {
      restoreOriginalTrack();
      return;
    }
    if (data.type !== 'NETFLIX_CONFIG') return;
    const next = data.payload && data.payload.sourceLang;
    const nextTarget = data.payload && data.payload.targetLang;
    if (next === 'ja' || next === 'ko') sourceLang = next;
    if (nextTarget === 'ja' || nextTarget === 'ko') targetLang = nextTarget;
    emitCurrentTrack(contentIdFromLocation());
  });

  setInterval(() => {
    const next = contentIdFromLocation();
    if (next !== currentContentId) {
      currentContentId = next;
      originalTrack = null;
      switchedTrack = false;
      trackScans = 0;
      reportedUnavailable = false;
      post('NETFLIX_NAVIGATE', { contentId: next });
      emitCurrentTrack(next);
    }

    // 플레이어와 트랙 목록은 재생 시작보다 늦게 준비될 수 있어 잠시 지켜본다.
    // 확보하면 ensureSourceTrack 이 스스로 빠져나오므로 상한만 둔다(약 60초).
    if (trackScans < 120) {
      trackScans++;
      ensureSourceTrack();
    }
  }, 500);

  debug('Netflix 자막 감시 시작', { sourceLang });
})();
