# 文章朗讀 Article Reader

貼上中英文混排的文章，用自然流暢的語音（中文 zh-TW / 英文 en-US）朗讀，並同步反白目前朗讀的句子，協助閱讀理解。可安裝到手機或電腦主畫面使用（PWA）。

## 本機執行

需要先安裝 Python 3.9 以上版本。

```bash
cd article-reader
python -m venv venv
source venv/bin/activate      # Windows 請用 venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

打開瀏覽器進入 `http://localhost:8000`，貼上文章、按「朗讀」即可測試。這份程式碼跟之後部署上線會跑的完全一樣，本機測試沒問題，上線後行為也會一致。

## 部署到 Render（免費）

1. 把這個資料夾 push 到一個 GitHub repo。
2. 到 [Render](https://render.com) 註冊 → **New → Web Service** → 連結該 GitHub repo。
3. Environment 選擇 **Python 3**。
4. Build command：
   ```
   pip install -r requirements.txt
   ```
5. Start command：
   ```
   uvicorn backend.main:app --host 0.0.0.0 --port $PORT
   ```
6. 按下部署，完成後 Render 會給一個免費的 HTTPS 網址（例如 `your-app.onrender.com`），電腦、手機都能直接開啟使用。

在手機瀏覽器打開這個網址後，可以用瀏覽器選單的「加入主畫面」把它安裝成像 App 一樣的圖示。

## 已知限制

- 使用的是免費、非官方的 `edge-tts` 套件，長期穩定性沒有官方保證。
- Render 免費方案閒置約 15 分鐘會休眠，之後第一次開啟網址會有約 30–50 秒的喚醒延遲。
- 沒有帳號與資料保存機制，每次重新貼文章即可，關閉分頁後不會留下紀錄。
- 中英文語言偵測與斷句是規則式判斷，遇到罕見的縮寫、符號可能偶爾切換不自然。
- 貼網址擷取文章功能已針對常見的內網位址做防護（SSRF），但沒有流量限制，理論上仍可能被拿來重複呼叫任意公開網址，屬於跟現有 App 一致的風險接受程度。

## 專案結構

```
article-reader/
  backend/
    main.py        # FastAPI 路由、掛載前端靜態檔案
    tts.py          # edge-tts 包裝：(text, lang) -> 語音 bytes
    segmenter.py     # 中英文語言／斷句邏輯
    extractor.py      # 網址擷取文章內容（含 SSRF 防護）
  static/
    index.html
    style.css
    app.js
    manifest.json
    service-worker.js
    icons/icon.svg
  requirements.txt
```
