from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .extractor import ExtractError, extract_article
from .segmenter import segment_text
from .tts import synthesize

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

MAX_ARTICLE_CHARS = 8000
MAX_SEGMENT_CHARS = 2000

app = FastAPI()


class ArticleRequest(BaseModel):
    text: str


class SegmentRequest(BaseModel):
    text: str
    lang: str


class ExtractRequest(BaseModel):
    url: str


@app.post("/api/extract")
def api_extract(req: ExtractRequest):
    try:
        result = extract_article(req.url)
    except ExtractError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(400, "擷取文章時發生錯誤，請稍後再試")

    text = result["text"]
    truncated = len(text) > MAX_ARTICLE_CHARS
    if truncated:
        text = text[:MAX_ARTICLE_CHARS]
    return {"title": result["title"], "text": text, "truncated": truncated}


@app.post("/api/segments")
def api_segments(req: ArticleRequest):
    if len(req.text) > MAX_ARTICLE_CHARS:
        raise HTTPException(400, f"文章過長，請控制在 {MAX_ARTICLE_CHARS} 字以內")
    return segment_text(req.text)


@app.post("/api/tts")
async def api_tts(req: SegmentRequest):
    if req.lang not in ("zh", "en"):
        raise HTTPException(400, "lang 必須是 zh 或 en")
    if len(req.text) > MAX_SEGMENT_CHARS:
        raise HTTPException(400, "單一片段過長")
    audio = await synthesize(req.text, req.lang)
    return Response(content=audio, media_type="audio/mpeg")


# Mounted last so it doesn't shadow the /api routes above.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
