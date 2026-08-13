/**
 * 서비스 워커 — 백엔드 호출을 전담한다.
 *
 * content script에서 직접 fetch 하지 않는 이유: Chrome 85 이후 content script의
 * fetch는 확장의 host_permissions 가 아니라 "페이지 오리진"의 CORS 규칙을 따른다.
 * 즉 youtube.com 문서에서 localhost:8080 을 부르면 백엔드의 CORS 설정에 인질이 된다.
 * 서비스 워커에서 부르면 host_permissions 로 제어할 수 있어 배포 시 백엔드의
 * ALLOWED_ORIGINS 를 좁혀도 확장은 계속 동작한다.
 *
 * 프로토콜: content → { type:'LFJP_API', op, payload } → { ok, data } | { ok:false, error }
 */
'use strict';

const DEFAULTS = {
  backendUrl: 'http://localhost:8080',
  level: 'N4',
  sourceLang: 'ja',
  targetLang: 'ko'
};

/** 배치 상한 — 백엔드가 500 초과를 400으로 거절한다. */
const MAX_BATCH = 500;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return {
    backendUrl: String(stored.backendUrl || DEFAULTS.backendUrl).replace(/\/+$/, ''),
    level: stored.level || DEFAULTS.level,
    sourceLang: stored.sourceLang || DEFAULTS.sourceLang,
    targetLang: stored.targetLang || DEFAULTS.targetLang
  };
}

/**
 * 백엔드 오류 본문은 항상 { error: "..." } 형태다.
 *
 * @param {string} path
 * @param {Object|null} body  null 이면 본문 없는 요청(GET/DELETE)
 * @param {string} [method]   기본 POST, 본문이 없으면 GET
 */
async function callBackend(path, body, method) {
  const { backendUrl } = await getSettings();
  const verb = method || (body ? 'POST' : 'GET');
  const init = { method: verb };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(backendUrl + path, init);

  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    /* 본문이 비어 있을 수 있다(204 등) */
  }
  if (!res.ok) {
    throw new Error((json && json.error) || 'HTTP ' + res.status);
  }
  return json;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ops = {
  async settings() {
    return getSettings();
  },

  /**
   * @param {{texts:string[]}} payload
   * @returns {Promise<{targets:string[]}>} 입력과 1:1 순서 보존
   */
  async translate({ texts }) {
    const { sourceLang, targetLang } = await getSettings();
    const targets = [];
    for (const part of chunk(texts || [], MAX_BATCH)) {
      const json = await callBackend('/v1/translate', {
        source_lang: sourceLang,
        target_lang: targetLang,
        texts: part
      });
      for (const t of json.translations || []) targets.push(t.target || '');
    }
    return { targets };
  },

  /**
   * @param {{texts:string[]}} payload
   * @returns {Promise<{results:Array<{text:string,tokens:Array}>}>}
   */
  async analyze({ texts }) {
    const { level, sourceLang } = await getSettings();
    if (sourceLang !== 'ja') {
      return { results: (texts || []).map((text) => ({ text, tokens: [] })) };
    }
    const results = [];
    for (const part of chunk(texts || [], MAX_BATCH)) {
      const json = await callBackend('/v1/nlp/analyze', { texts: part, level });
      for (const r of json.results || []) results.push(r);
    }
    return { results };
  },

  /** @returns {Promise<{expressions:Array, total:number}>} 최신 저장 순 */
  async listExpressions({ limit, offset } = {}) {
    const q = new URLSearchParams({
      limit: String(limit || 200),
      offset: String(offset || 0)
    });
    const json = await callBackend('/v1/expressions?' + q.toString(), null);
    return { expressions: (json && json.expressions) || [], total: (json && json.total) || 0 };
  },

  async deleteExpression({ id }) {
    await callBackend('/v1/expressions/' + encodeURIComponent(id), null, 'DELETE');
    return { deleted: id };
  },

  /** @param {{surface,reading,gloss,jlpt,context,source}} payload */
  async saveExpression(payload) {
    const created = await callBackend('/v1/expressions', {
      surface: payload.surface,
      reading: payload.reading || '',
      gloss: payload.gloss || '',
      jlpt: payload.jlpt || '',
      context: payload.context || '',
      source: payload.source || {}
    });
    return { expression: created };
  },

  async shadowingSet({ cues, limit }) {
    const { level, sourceLang } = await getSettings();
    return callBackend('/v1/shadowing/set', {
      cues: cues || [],
      level,
      source_lang: sourceLang,
      limit: limit || 8
    });
  },

  async saveShadowingAttempt(payload) {
    return callBackend('/v1/shadowing/attempts', payload);
  },

  async listShadowingReviews({ dueBefore, limit } = {}) {
    const q = new URLSearchParams({ limit: String(limit || 20) });
    if (dueBefore) q.set('due_before', dueBefore);
    return callBackend('/v1/shadowing/reviews?' + q.toString(), null);
  },

  async completeShadowingReview({ id, score }) {
    return callBackend(
      '/v1/shadowing/attempts/' + encodeURIComponent(id) + '/review',
      { score }
    );
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'LFJP_API') return false;
  const handler = ops[msg.op];
  if (!handler) {
    sendResponse({ ok: false, error: 'unknown op: ' + msg.op });
    return false;
  }
  handler(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // 비동기 응답을 쓰겠다는 신호
});
