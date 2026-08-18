/**
 * 백엔드 클라이언트 — 실제 fetch 는 서비스 워커가 한다(background.js 주석 참고).
 * 여기서는 메시지 왕복만 감싸고, "백엔드가 죽어 있어도 자막은 계속 보여야 한다"는
 * 원칙에 따라 실패를 예외가 아닌 값으로 돌려준다.
 */
'use strict';

(() => {
  var LFJP = window.LFJP;

  function send(op, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'LFJP_API', op, payload }, (res) => {
          // 확장 리로드 등으로 채널이 끊기면 예외 대신 lastError 가 채워진다.
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, error: '빈 응답' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  const localTranslatorCache = new Map();

  async function getLocalTranslator(sourceLanguage, targetLanguage) {
    if (!('Translator' in self)) return null;
    const key = `${sourceLanguage}|${targetLanguage}`;
    if (!localTranslatorCache.has(key)) {
      const promise = (async () => {
        const availability = await self.Translator.availability({ sourceLanguage, targetLanguage });
        if (availability === 'unavailable') return null;
        return self.Translator.create({
          sourceLanguage,
          targetLanguage,
          monitor(monitor) {
            monitor.addEventListener('downloadprogress', (event) => {
              const percent = Math.round(Number(event.loaded || 0) * 100);
              LFJP.log(`Chrome 로컬 번역 모델 준비 중 — ${percent}%`);
            });
          }
        });
      })().catch((err) => {
        localTranslatorCache.delete(key);
        LFJP.warn('Chrome 로컬 번역을 준비하지 못했습니다:', err.message || String(err));
        return null;
      });
      localTranslatorCache.set(key, promise);
    }
    return localTranslatorCache.get(key);
  }

  async function translateLocally(texts) {
    const settings = await chrome.storage.sync.get({ sourceLang: 'ja', targetLang: 'ko' });
    const translator = await getLocalTranslator(settings.sourceLang, settings.targetLang);
    if (!translator) return null;
    const targets = [];
    for (const value of texts || []) {
      try {
        targets.push(value ? await translator.translate(value) : '');
      } catch (err) {
        LFJP.warn('Chrome 로컬 번역 실패:', err.message || String(err));
        targets.push('');
      }
    }
    return targets;
  }

  LFJP.api = {
    async settings() {
      const res = await send('settings', {});
      return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, error: res.error };
    },

    /**
     * 설정된 학습 언어 cue → 보조 언어. 500개 초과 청크 분할은 서비스 워커가 처리한다.
     * @returns {Promise<{ok:boolean, targets?:string[], error?:string}>} 입력과 1:1
     */
    async translate(texts) {
      const res = await send('translate', { texts });
      const targets = res.ok
        ? [...((res.data && res.data.targets) || [])]
        : (texts || []).map(() => '');
      while (targets.length < (texts || []).length) targets.push('');

      const missing = targets.map((value, i) => value ? -1 : i).filter((i) => i >= 0);
      if (missing.length) {
        const local = await translateLocally(missing.map((i) => texts[i]));
        if (local) missing.forEach((targetIndex, i) => {
          targets[targetIndex] = local[i] || '';
        });
      }

      if (!res.ok && !targets.some(Boolean)) return { ok: false, error: res.error };
      return { ok: true, targets };
    },

    /**
     * 형태소 분석. 응답 토큰의 start/end 는 UTF-16 코드 유닛 오프셋이라
     * text.slice(start, end) 로 바로 자른다(클라이언트 재토큰화 금지).
     * @returns {Promise<{ok:boolean, results?:Array<{text:string,tokens:Array}>, error?:string}>}
     */
    async analyze(texts) {
      const res = await send('analyze', { texts });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, results: (res.data && res.data.results) || [] };
    },

    /**
     * 단어 사전 조회. 뜻·읽기·품사·문맥 설명을 한 번에 받는다.
     *
     * 백엔드에 API 키가 없으면 senses 가 빈 항목이 돌아온다. 그때는 호출자가
     * translate 로 폴백해야 하므로 실패로 취급하지 않고 그대로 넘긴다.
     *
     * @param {Array<{surface:string, lemma?:string, reading?:string, pos?:string, context?:string}>} items
     * @returns {Promise<{ok:boolean, entries?:Array, error?:string}>} 입력과 1:1
     */
    async dictLookup(items) {
      const res = await send('dictLookup', { items });
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, entries: (res.data && res.data.entries) || [] };
    },

    /** @returns {Promise<{ok:boolean, expression?:Object, error?:string}>} */
    async saveExpression(payload) {
      const res = await send('saveExpression', payload);
      if (!res.ok) return { ok: false, error: res.error };
      return { ok: true, expression: res.data && res.data.expression };
    },

    /** @returns {Promise<{ok:boolean, expressions?:Array, total?:number, error?:string}>} */
    async listExpressions(filters) {
      const res = await send('listExpressions', filters || {});
      if (!res.ok) return { ok: false, error: res.error };
      return {
        ok: true,
        expressions: (res.data && res.data.expressions) || [],
        total: (res.data && res.data.total) || 0
      };
    },

    /** @returns {Promise<{ok:boolean, error?:string}>} */
    async deleteExpression(id) {
      const res = await send('deleteExpression', { id });
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },

    async shadowingSet(cues, limit) {
      const res = await send('shadowingSet', { cues, limit });
      return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, error: res.error };
    },

    async saveShadowingAttempt(payload) {
      const res = await send('saveShadowingAttempt', payload);
      return res.ok ? { ok: true, attempt: res.data } : { ok: false, error: res.error };
    },

    async listShadowingReviews(dueBefore) {
      const res = await send('listShadowingReviews', { dueBefore, limit: 20 });
      return res.ok ? { ok: true, ...(res.data || {}) } : { ok: false, error: res.error };
    },

    async completeShadowingReview(id, score) {
      const res = await send('completeShadowingReview', { id, score });
      return res.ok ? { ok: true, attempt: res.data } : { ok: false, error: res.error };
    }
  };
})();
