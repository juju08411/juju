"""Split article text into ordered (text, lang) segments for TTS.

Two passes:
1. Split into runs of Chinese (CJK) vs. everything else, since edge-tts
   needs one voice per call and can't read mixed zh/en text naturally.
2. Split each run further on sentence-ending punctuation, so segments
   stay short (lower TTS latency, finer read-along highlighting).

A short numeric/punctuation-only run between two Chinese runs (e.g. a
date or number embedded in a Chinese sentence) is merged back into the
neighboring Chinese run instead of becoming its own English segment,
since the zh-TW voice reads Arabic numerals fine.
"""

import re

CJK_RANGE = r"一-鿿㐀-䶿豈-﫿　-〿＀-￯"
CJK_RUN = re.compile(f"[{CJK_RANGE}]+")

ZH_SENTENCE_END = re.compile(r"(?<=[。！？；\n])")
EN_SENTENCE_END = re.compile(r"(?<=[.!?;\n])\s+")

NUMERIC_ONLY = re.compile(r"^[\d\s.,:%\-/()]+$")


def _split_into_runs(text):
    runs = []
    pos = 0
    for match in CJK_RUN.finditer(text):
        if match.start() > pos:
            runs.append([text[pos:match.start()], "en"])
        runs.append([match.group(), "zh"])
        pos = match.end()
    if pos < len(text):
        runs.append([text[pos:], "en"])
    return runs


def _merge_numeric_gaps(runs):
    i = 0
    while i < len(runs):
        text, lang = runs[i]
        if lang == "en" and NUMERIC_ONLY.match(text):
            prev_zh = i > 0 and runs[i - 1][1] == "zh"
            next_zh = i < len(runs) - 1 and runs[i + 1][1] == "zh"
            if prev_zh:
                runs[i - 1][0] += text
                runs.pop(i)
                continue
            if next_zh:
                runs[i + 1][0] = text + runs[i + 1][0]
                runs.pop(i)
                continue
        i += 1
    return runs


def _split_sentences(text, lang):
    pattern = ZH_SENTENCE_END if lang == "zh" else EN_SENTENCE_END
    return [part.strip() for part in pattern.split(text) if part.strip()]


def segment_text(text):
    text = text.strip()
    if not text:
        return []

    runs = _merge_numeric_gaps(_split_into_runs(text))

    segments = []
    for run_text, lang in runs:
        if not run_text.strip():
            continue
        for sentence in _split_sentences(run_text, lang):
            segments.append({"text": sentence, "lang": lang})
    return segments
