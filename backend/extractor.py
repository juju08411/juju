"""Fetch a URL server-side and extract its main article text.

This endpoint is public and unauthenticated, and it makes the server issue
outbound HTTP requests to whatever URL a visitor supplies — a classic SSRF
surface. Before fetching, every resolved IP for the hostname is checked
against private/loopback/link-local/reserved ranges and rejected if any
match, which covers localhost, cloud metadata endpoints (169.254.169.254),
and internal network addresses without needing a hostname blocklist.
"""

import ipaddress
import socket
from urllib.parse import urlsplit

import requests
import trafilatura

MAX_FETCH_BYTES = 2_000_000
REQUEST_TIMEOUT = (3.05, 10)
USER_AGENT = "Mozilla/5.0 (compatible; ArticleReaderBot/1.0)"


class ExtractError(Exception):
    pass


def _reject_unsafe_host(hostname):
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise ExtractError("無法解析此網址")

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            # Deliberately generic message — don't reveal why a URL was blocked.
            raise ExtractError("不支援此網址")


def _validate_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ExtractError("請提供有效的網址（需以 http:// 或 https:// 開頭）")
    _reject_unsafe_host(parts.hostname)


def _fetch_html(url):
    session = requests.Session()
    session.max_redirects = 5
    try:
        response = session.get(
            url,
            timeout=REQUEST_TIMEOUT,
            stream=True,
            allow_redirects=True,
            headers={"User-Agent": USER_AGENT},
        )
    except requests.exceptions.Timeout:
        raise ExtractError("擷取逾時，請確認網址是否正確或稍後再試")
    except requests.exceptions.RequestException:
        raise ExtractError("無法讀取該網址")

    # A redirect chain can land on a different host than the one already
    # validated — re-check the final URL. This doesn't re-validate each
    # intermediate hop (a small residual TOCTOU/DNS-rebinding gap), which is
    # an accepted tradeoff for a personal-use tool rather than a hardened one.
    if response.url != url:
        _validate_url(response.url)

    if response.status_code != 200:
        response.close()
        raise ExtractError(f"無法讀取該網址（伺服器回應 {response.status_code}）")

    content_type = response.headers.get("Content-Type", "")
    if "html" not in content_type.lower():
        response.close()
        raise ExtractError("此網址不是網頁內容，無法擷取文章")

    content_length = response.headers.get("Content-Length")
    if content_length and int(content_length) > MAX_FETCH_BYTES:
        response.close()
        raise ExtractError("網頁內容過大，無法擷取")

    chunks = bytearray()
    for chunk in response.iter_content(chunk_size=8192):
        chunks.extend(chunk)
        if len(chunks) > MAX_FETCH_BYTES:
            response.close()
            raise ExtractError("網頁內容過大，無法擷取")

    encoding = response.encoding or response.apparent_encoding or "utf-8"
    response.close()
    return bytes(chunks).decode(encoding, errors="replace")


def extract_article(url):
    _validate_url(url)
    html = _fetch_html(url)

    result = trafilatura.bare_extraction(
        html,
        url=url,
        as_dict=True,
        with_metadata=True,
        deduplicate=True,
        include_comments=False,
        include_tables=False,
        favor_recall=True,
    )

    text = (result or {}).get("text") or ""
    if not text.strip():
        raise ExtractError(
            "無法從此網址擷取文章內容，請確認是否為文章頁面，或直接貼上文字"
        )

    return {"title": (result or {}).get("title") or "", "text": text}
