# nlp-service — 일본어 형태소 분석

Python / FastAPI + SudachiPy. Go 백엔드가 프록시하며, **확장은 이 서비스를 직접 호출하지 않는다.**

일본어는 띄어쓰기가 없어서 형태소 분석이 단어 단위 기능(탭·저장·하이라이트·후리가나)의 전제다.

## 실행

```bash
cd nlp-service
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m uvicorn app.main:app --port 8100
```

그다음 백엔드를 이 서비스에 연결한다:

```bash
cd ../backend
NLP_SERVICE_URL=http://localhost:8100 go run ./cmd/api
```

`GET /healthz`가 `{"status":"ok","analyzer":"sudachipy"}`를 반환하면 정상.

## API

### `POST /analyze`

```json
// 요청
{ "texts": ["日本語を勉強しています"], "level": "N4" }

// 응답
{ "results": [{ "text": "...", "tokens": [
  { "surface": "勉強", "reading": "べんきょう", "lemma": "勉強",
    "pos": "名詞", "jlpt": "N4", "gloss": "",
    "start": 4, "end": 6, "highlight": true }
]}]}
```

배치 최대 500개. 필드 의미는 [`../backend/README.md`](../backend/README.md)의 `/v1/nlp/analyze` 항목과 동일하다.

## 설계 노트

**분절 단위 — Sudachi Split Mode C.** 복합어를 붙여서 유지한다(`日本語`가 `日本`+`語`로 쪼개지지 않음). 학습자가 어휘를 인식하는 단위와 일치한다.

**후리가나.** Sudachi는 읽기를 가타카나로 주는데, 후리가나는 관례상 히라가나라 변환한다. 읽기가 표기와 같으면(= 한자가 없으면) 빈 값으로 둔다.

**오프셋은 UTF-16 코드 유닛.** Sudachi는 코드 포인트 기준으로 위치를 주지만, 확장은 자바스크립트에서 문자열을 자른다. BMP 밖 문자(희귀 한자, 이모지)가 하나라도 있으면 두 기준이 어긋나 이후 하이라이트가 전부 밀린다. `_utf16_offsets()`가 이걸 변환한다.

**하이라이트 판정.** 조사·조동사·기호(`助詞`/`助動詞`/`補助記号`/`空白`)는 문법이지 어휘가 아니라 제외한다. 나머지는 토큰의 JLPT 레벨이 사용자 레벨과 같거나 더 어려우면 하이라이트한다.

## 한계 (알고 있는 것)

- **JLPT 목록이 시드 수준이다.** `app/jlpt.py`의 `SEED`는 검증용 상용 어휘 일부일 뿐이다. 목록에 없는 단어는 "모르는 단어"로 간주해 하이라이트되므로, 시드만으로는 **대부분의 내용어가 하이라이트된다.** 정식 JLPT 어휘 데이터셋으로 교체해야 한다.
- **`gloss`는 항상 비어 있다.** 이 서비스는 분절·읽기·JLPT만 담당한다. 뜻풀이는 백엔드의
  `/v1/dict/lookup`(문맥 사전)이 맡는다 — 이유는 `../backend/README.md` 참고.
