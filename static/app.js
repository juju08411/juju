const articleInput = document.getElementById("article-input");
const readBtn = document.getElementById("read-btn");
const playPauseBtn = document.getElementById("play-pause-btn");
const speedSelect = document.getElementById("speed-select");
const statusEl = document.getElementById("status");
const articleView = document.getElementById("article-view");

// Group consecutive same-language sentences into one TTS call (up to this
// many characters) instead of one call per sentence. This is what actually
// fixes long pauses at punctuation: each isolated per-sentence clip got its
// own "closing" pause from the TTS engine, and every clip boundary meant
// waiting on a fresh network round-trip. Merged calls let the voice pace
// its own natural inter-sentence pause instead.
const MAX_CHUNK_CHARS = 150;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

let segments = []; // fine-grained sentence list — drives the highlightable spans
let chunks = []; // grouped same-language runs — drives actual TTS calls/playback
let currentChunkIndex = -1;
let highlightedSegIndex = -1;
let currentThresholds = [];
let audioCache = new Map(); // chunkIndex -> Promise<blob URL>
let isPlaying = false;

const audioEl = new Audio();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setStatus(text) {
  statusEl.textContent = text;
}

function buildChunks(segs, maxChars) {
  const result = [];
  let i = 0;
  while (i < segs.length) {
    const lang = segs[i].lang;
    let text = segs[i].text;
    const startIdx = i;
    let endIdx = i;
    let j = i + 1;
    while (
      j < segs.length &&
      segs[j].lang === lang &&
      text.length + segs[j].text.length + 1 <= maxChars
    ) {
      text += (lang === "zh" ? "" : " ") + segs[j].text;
      endIdx = j;
      j++;
    }
    result.push({ lang, text, startIdx, endIdx });
    i = j;
  }
  return result;
}

// Approximates where each sentence starts within a merged chunk's audio,
// proportional to character count, so we can still highlight sentence by
// sentence without needing exact TTS word-boundary timestamps.
function computeThresholds(chunk) {
  const lens = [];
  for (let i = chunk.startIdx; i <= chunk.endIdx; i++) lens.push(segments[i].text.length);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let cum = 0;
  return lens.map((len, idx) => {
    const startFraction = cum / total;
    cum += len;
    return { segIndex: chunk.startIdx + idx, startFraction };
  });
}

async function fetchChunkAudioOnce(index) {
  const chunk = chunks[index];
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: chunk.text, lang: chunk.lang }),
  });
  if (!res.ok) throw new Error(`TTS request failed (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

async function fetchChunkAudioWithRetry(index) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchChunkAudioOnce(index);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

function fetchChunkAudio(index) {
  if (audioCache.has(index)) return audioCache.get(index);
  const promise = fetchChunkAudioWithRetry(index);
  audioCache.set(index, promise);
  // A failed fetch shouldn't stay cached forever — let a later retry re-fetch.
  promise.catch(() => {
    if (audioCache.get(index) === promise) audioCache.delete(index);
  });
  return promise;
}

function renderArticle() {
  articleView.innerHTML = "";
  segments.forEach((seg, i) => {
    const span = document.createElement("span");
    span.textContent = seg.text + (seg.lang === "zh" ? "" : " ");
    span.dataset.index = String(i);
    span.className = "segment";
    articleView.appendChild(span);
  });
}

function highlight(segIndex) {
  if (segIndex === highlightedSegIndex) return;
  const prev = articleView.querySelector(".segment.active");
  if (prev) prev.classList.remove("active");
  const el = articleView.querySelector(`[data-index="${segIndex}"]`);
  if (el) {
    el.classList.add("active");
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  highlightedSegIndex = segIndex;
  if (isPlaying) setStatus(`朗讀中 (${segIndex + 1}/${segments.length})`);
}

async function playChunk(index) {
  if (!isPlaying) return; // user paused/stopped while we were waiting on something

  if (index >= chunks.length) {
    setStatus("朗讀完成");
    isPlaying = false;
    playPauseBtn.textContent = "播放";
    playPauseBtn.disabled = true;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "none";
    return;
  }

  currentChunkIndex = index;
  const chunk = chunks[index];
  currentThresholds = computeThresholds(chunk);
  highlight(chunk.startIdx);

  if (index + 1 < chunks.length) {
    fetchChunkAudio(index + 1).catch(() => {});
  }

  let url;
  try {
    url = await fetchChunkAudio(index);
  } catch (err) {
    // This chunk failed after retries — skip it and keep going rather
    // than stopping the whole read-aloud session over one bad chunk.
    setStatus(`第 ${chunk.startIdx + 1} 句語音失敗，已略過`);
    return playChunk(index + 1);
  }

  if (!isPlaying) return; // user paused while we were fetching

  audioEl.src = url;
  audioEl.playbackRate = parseFloat(speedSelect.value);
  try {
    await audioEl.play();
  } catch (err) {
    // play() can reject transiently (e.g. autoplay policy hiccups) — retry once.
    await sleep(500);
    if (isPlaying) audioEl.play().catch(() => playChunk(index + 1));
  }
}

audioEl.addEventListener("timeupdate", () => {
  if (!currentThresholds.length || !audioEl.duration) return;
  const progress = audioEl.currentTime / audioEl.duration;
  let active = currentThresholds[0];
  for (const t of currentThresholds) {
    if (progress >= t.startFraction) active = t;
    else break;
  }
  highlight(active.segIndex);
});

audioEl.addEventListener("ended", () => {
  if (isPlaying) playChunk(currentChunkIndex + 1);
});

audioEl.addEventListener("error", () => {
  // A mid-playback decode/network error never fires "ended", so without
  // this the session would silently hang on the current chunk forever.
  if (isPlaying && currentChunkIndex >= 0) playChunk(currentChunkIndex + 1);
});

readBtn.addEventListener("click", async () => {
  const text = articleInput.value.trim();
  if (!text) {
    setStatus("請先貼上文章");
    return;
  }

  readBtn.disabled = true;
  playPauseBtn.disabled = true;
  setStatus("分析文章中...");
  audioCache = new Map();
  audioEl.pause();

  try {
    const res = await fetch("/api/segments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error("segment request failed");
    segments = await res.json();
  } catch (err) {
    setStatus("分析文章失敗，請稍後再試");
    readBtn.disabled = false;
    return;
  }

  readBtn.disabled = false;

  if (segments.length === 0) {
    setStatus("沒有可朗讀的內容");
    return;
  }

  chunks = buildChunks(segments, MAX_CHUNK_CHARS);
  highlightedSegIndex = -1;
  renderArticle();
  playPauseBtn.disabled = false;
  playPauseBtn.textContent = "暫停";
  isPlaying = true;
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  await playChunk(0);
});

playPauseBtn.addEventListener("click", () => {
  if (currentChunkIndex < 0) return;
  if (isPlaying) {
    audioEl.pause();
    isPlaying = false;
    playPauseBtn.textContent = "播放";
    setStatus("已暫停");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  } else {
    isPlaying = true;
    playPauseBtn.textContent = "暫停";
    setStatus(`朗讀中 (${highlightedSegIndex + 1}/${segments.length})`);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    // If we paused before the current chunk ever got a src (e.g. while it
    // was still fetching), resume by re-driving playChunk instead of
    // calling play() on a src-less/ended element, which would do nothing.
    if (audioEl.currentSrc && !audioEl.ended) {
      audioEl.play().catch(() => playChunk(currentChunkIndex));
    } else {
      playChunk(currentChunkIndex);
    }
  }
});

speedSelect.addEventListener("change", () => {
  audioEl.playbackRate = parseFloat(speedSelect.value);
});

// Media Session: gives the OS/lock-screen play-pause controls and helps
// mobile browsers keep audio alive when the app is backgrounded.
if ("mediaSession" in navigator) {
  navigator.mediaSession.metadata = new MediaMetadata({ title: "文章朗讀" });
  navigator.mediaSession.setActionHandler("play", () => {
    if (currentChunkIndex >= 0 && !isPlaying) playPauseBtn.click();
  });
  navigator.mediaSession.setActionHandler("pause", () => {
    if (isPlaying) playPauseBtn.click();
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
