"""FastAPI wrapper around the Japanese analyzer.

The Go backend proxies to this service; the extension never calls it directly.
"""

from fastapi import FastAPI
from pydantic import BaseModel, Field

from . import analyzer

MAX_BATCH = 500

app = FastAPI(title="langflix-jp NLP", version="0.1.0")


class AnalyzeRequest(BaseModel):
    texts: list[str] = Field(default_factory=list)
    level: str | None = None


class Token(BaseModel):
    surface: str
    reading: str = ""
    lemma: str = ""
    pos: str = ""
    jlpt: str = ""
    gloss: str = ""
    start: int
    end: int
    highlight: bool = False


class Analysis(BaseModel):
    text: str
    tokens: list[Token]


class AnalyzeResponse(BaseModel):
    results: list[Analysis]


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "analyzer": "sudachipy"}


@app.post("/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    texts = req.texts[:MAX_BATCH]
    return AnalyzeResponse(
        results=[
            Analysis(text=text, tokens=analyzer.analyze(text, req.level))
            for text in texts
        ]
    )
