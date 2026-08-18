/**
 * 설정 화면 (popup 겸 options).
 *
 * 저장 대상은 두 개뿐이다 — 백엔드 주소, JLPT 레벨. 레벨은 서비스 워커가
 * /v1/nlp/analyze 의 level 로 실어 보낸다.
 */
'use strict';

const DEFAULTS = {
  backendUrl: 'http://localhost:8090',
  level: 'N4',
  sourceLang: 'ja',
  targetLang: 'ko'
};

/**
 * manifest 의 host_permissions 에 이미 들어 있는 호스트.
 *
 * 매치 패턴에는 포트를 쓸 수 없고(`http://localhost:8090/*` 는 무효한 패턴이다),
 * `http://localhost/*` 는 모든 포트에 매칭된다. 그래서 포트가 아니라 호스트로 본다 —
 * 로컬 백엔드는 어느 포트로 띄우든 추가 권한 요청 없이 동작한다.
 */
const BUILTIN_HOSTS = ['localhost', '127.0.0.1'];

function isBuiltin(url) {
  return url.protocol === 'http:' && BUILTIN_HOSTS.includes(url.hostname);
}

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function normalize(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('backendUrl').value = s.backendUrl;
  $('level').value = s.level;
  $('direction').value = `${s.sourceLang}-${s.targetLang}`;
});

$('save').addEventListener('click', async () => {
  const backendUrl = normalize($('backendUrl').value) || DEFAULTS.backendUrl;
  const level = $('level').value;
  const [sourceLang, targetLang] = $('direction').value.split('-');

  let parsed;
  try {
    parsed = new URL(backendUrl);
  } catch (_) {
    setStatus('주소 형식이 올바르지 않습니다.', 'err');
    return;
  }

  // 로컬 호스트가 아니면 서비스 워커가 호출할 수 있도록 권한을 추가로 받아야 한다.
  // (사용자 제스처 안에서만 요청할 수 있어 저장 버튼 핸들러에 둔다.)
  if (!isBuiltin(parsed)) {
    const granted = await chrome.permissions.request({ origins: [parsed.origin + '/*'] });
    if (!granted) {
      setStatus('해당 주소에 대한 접근 권한이 거부되어 저장하지 않았습니다.', 'err');
      return;
    }
  }

  await chrome.storage.sync.set({ backendUrl, level, sourceLang, targetLang });
  setStatus('저장했습니다. 재생 중인 탭은 새로고침하세요.', 'ok');
});

$('test').addEventListener('click', async () => {
  const backendUrl = normalize($('backendUrl').value) || DEFAULTS.backendUrl;
  setStatus('확인 중…');
  try {
    const res = await fetch(backendUrl + '/healthz');
    const json = await res.json();
    setStatus(
      `연결 성공 — 번역: ${json.translator}, NLP: ${json.nlp}`,
      'ok'
    );
  } catch (err) {
    setStatus('연결 실패: ' + err.message + ' (백엔드가 떠 있는지 확인하세요)', 'err');
  }
});
