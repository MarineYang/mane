/**
 * Chrome Translator API는 서비스 워커에서 제공되지 않는다.
 * 확장 오프스크린 문서에서 모델을 한 번 만들고 문장·단어 번역에 함께 사용한다.
 */
'use strict';

const translators = new Map();
const translated = new Map();

async function getTranslator(sourceLanguage, targetLanguage) {
  if (!('Translator' in self)) return null;
  const key = `${sourceLanguage}|${targetLanguage}`;
  if (!translators.has(key)) {
    translators.set(key, (async () => {
      const availability = await self.Translator.availability({ sourceLanguage, targetLanguage });
      if (availability === 'unavailable') return null;
      return self.Translator.create({ sourceLanguage, targetLanguage });
    })().catch(() => null));
  }
  return translators.get(key);
}

async function translateAll(texts, sourceLanguage, targetLanguage) {
  const translator = await getTranslator(sourceLanguage, targetLanguage);
  if (!translator) throw new Error('Chrome 내장 번역을 사용할 수 없습니다. Chrome 138+가 필요합니다.');

  const pair = `${sourceLanguage}|${targetLanguage}`;
  const targets = [];
  for (const text of texts || []) {
    const key = `${pair}|${text}`;
    if (translated.has(key)) {
      targets.push(translated.get(key));
      continue;
    }
    const value = text ? await translator.translate(text) : '';
    translated.set(key, value);
    targets.push(value);
  }
  return targets;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'LFJP_OFFSCREEN_TRANSLATE') return false;
  translateAll(message.texts, message.sourceLanguage, message.targetLanguage)
    .then((targets) => sendResponse({ ok: true, targets }))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
