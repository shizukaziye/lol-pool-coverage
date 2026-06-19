"""
Lolalytics fetcher with Cloudflare bypass.

Strategy:
  1. Launch headless Chromium with playwright-stealth applied.
  2. First request: navigate to a benign HTML page (lolalytics.com/lol/) — this
     lets Cloudflare Turnstile run and drop the cf_clearance cookie.
  3. Save cookies to .cf-cookies.json so subsequent runs reuse the clearance
     instead of solving the challenge every time.
  4. For each q-data.json endpoint, prefer page.evaluate(fetch) so the request
     carries the page-origin cookies and a real browser User-Agent. Fall back
     to context.request if the page is already loaded.

If a request returns 403 we re-navigate to refresh the challenge.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

BASE = "https://lolalytics.com"
COOKIE_FILE = Path(__file__).parent / ".cf-cookies.json"
WARMUP_URL = f"{BASE}/lol/"


def tierlist_url(lane: str, patch_param: str) -> str:
    return f"{BASE}/lol/tierlist/q-data.json?lane={lane}&patch={patch_param}"


def build_url(champ_slug: str, lane: str, patch_param: str) -> str:
    return f"{BASE}/lol/{champ_slug}/build/q-data.json?lane={lane}&patch={patch_param}"


def build_html_url(champ_slug: str, lane: str, patch_param: str) -> str:
    return f"{BASE}/lol/{champ_slug}/build/?lane={lane}&patch={patch_param}"


class LolalyticsClient:
    """Async Playwright-backed fetcher. Use as `async with LolalyticsClient() as c:`."""

    def __init__(self, headless: bool = True, min_delay: float = 0.5, max_delay: float = 1.0):
        self.headless = headless
        self.min_delay = min_delay
        self.max_delay = max_delay
        self._playwright = None
        self._browser = None
        self._context = None
        self._page = None
        self._warmed = False

    async def __aenter__(self):
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(headless=self.headless)

        context_args: dict[str, Any] = {
            "user_agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "viewport": {"width": 1280, "height": 800},
            "locale": "en-US",
        }
        if COOKIE_FILE.exists():
            try:
                state = json.loads(COOKIE_FILE.read_text())
                context_args["storage_state"] = state
                logger.info("Loaded saved cookies from %s", COOKIE_FILE)
            except Exception as e:
                logger.warning("Failed to load cookies: %s", e)

        self._context = await self._browser.new_context(**context_args)

        # Apply stealth. Library API varies across versions; try both shapes.
        try:
            from playwright_stealth import stealth_async  # type: ignore

            self._page = await self._context.new_page()
            await stealth_async(self._page)
        except ImportError:
            try:
                from playwright_stealth import Stealth  # type: ignore

                await Stealth().apply_stealth_async(self._context)
                self._page = await self._context.new_page()
            except Exception as e:
                logger.warning("playwright-stealth not available (%s); continuing without", e)
                self._page = await self._context.new_page()

        return self

    async def __aexit__(self, *_exc):
        try:
            if self._context:
                state = await self._context.storage_state()
                COOKIE_FILE.write_text(json.dumps(state))
                logger.info("Saved cookies to %s", COOKIE_FILE)
        except Exception as e:
            logger.warning("Failed to save cookies: %s", e)

        if self._context:
            await self._context.close()
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()

    async def _warmup(self):
        """Navigate to the homepage so Cloudflare drops a cf_clearance cookie."""
        if self._warmed:
            return
        logger.info("Warming up: navigating to %s", WARMUP_URL)
        await self._page.goto(WARMUP_URL, wait_until="domcontentloaded", timeout=60_000)
        # Give Turnstile a moment to settle.
        await asyncio.sleep(3.0)
        self._warmed = True

    async def _polite_delay(self):
        await asyncio.sleep(random.uniform(self.min_delay, self.max_delay))

    async def fetch_json(self, url: str, referer_html: Optional[str] = None, max_retries: int = 4) -> dict:
        """Fetch a q-data.json endpoint and return the parsed JSON dict."""
        await self._warmup()

        backoff = 2.0
        last_err: Optional[Exception] = None

        for attempt in range(max_retries):
            try:
                # If a referer_html is given (a build HTML page), navigate there first
                # so the JSON fetch carries the right origin context.
                if referer_html and attempt == 0:
                    try:
                        await self._page.goto(referer_html, wait_until="domcontentloaded", timeout=60_000)
                        await asyncio.sleep(1.0)
                    except Exception as e:
                        logger.warning("Referer nav failed (%s): %s", referer_html, e)

                # Run a fetch from inside the page context.
                result = await self._page.evaluate(
                    """async (url) => {
                        const r = await fetch(url, { credentials: 'include' });
                        return { status: r.status, body: await r.text() };
                    }""",
                    url,
                )

                status = result.get("status")
                body = result.get("body") or ""

                if status == 200:
                    await self._polite_delay()
                    return json.loads(body)

                if status == 429:
                    wait = backoff * (2**attempt) + random.uniform(0, 1)
                    logger.warning("429 from %s — sleeping %.1fs", url, wait)
                    await asyncio.sleep(wait)
                    continue

                if status == 403:
                    logger.warning("403 from %s (attempt %d) — re-warming", url, attempt + 1)
                    self._warmed = False
                    await self._warmup()
                    await asyncio.sleep(backoff * (2**attempt))
                    continue

                raise RuntimeError(f"unexpected status {status} for {url}: {body[:200]}")

            except Exception as e:
                last_err = e
                logger.warning("fetch_json error (attempt %d) for %s: %s", attempt + 1, url, e)
                await asyncio.sleep(backoff * (2**attempt))

        raise RuntimeError(f"fetch_json failed after {max_retries} attempts: {url} ({last_err})")
