"""Thin wrapper around edge-tts: (text, lang) -> audio bytes, no disk I/O."""

import edge_tts

VOICES = {
    "zh": "zh-TW-HsiaoChenNeural",
    "en": "en-US-AriaNeural",
}


async def synthesize(text: str, lang: str) -> bytes:
    voice = VOICES.get(lang, VOICES["en"])
    communicate = edge_tts.Communicate(text, voice)
    audio = bytearray()
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
    return bytes(audio)
