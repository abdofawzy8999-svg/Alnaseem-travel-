#!/usr/bin/env python3
"""Render the Al-Naseem Travel news template to PNG (feed 1080x1350 and story 1080x1920).

Usage:
  python3 assets/news/render.py news.json OUT_FEED.png OUT_STORY.png

news.json fields (all text in Egyptian Arabic):
  kind       "flight" | "umrah"            -> background decoration
  badge      short category, e.g. "أخبار الطيران" / "أخبار العمرة" / "خبر عاجل"
  date       e.g. "الاثنين 26 أكتوبر 2026"
  headline   one sentence, max ~70 characters (auto-shrinks to fit 3 lines)
  highlight  optional short key fact (max ~40 characters), e.g. a date or price
  points     2-4 short facts (max ~60 characters each)
  action     one practical line: what the reader should do
  source     e.g. "المصدر: وزارة الحج والعمرة السعودية"
Requires Playwright's Chromium (preinstalled in Claude cloud sessions).
"""
import json, sys, pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent

def render(data, out_feed, out_story):
    url = (HERE / "template.html").as_uri()
    with sync_playwright() as p:
        b = p.chromium.launch()
        for fmt, out, h in (("feed", out_feed, 1350), ("story", out_story, 1920)):
            pg = b.new_page(viewport={"width": 1080, "height": h}, device_scale_factor=1)
            pg.add_init_script("window.NEWS = " + json.dumps(dict(data, format=fmt), ensure_ascii=False) + ";")
            pg.goto(url)
            pg.wait_for_selector("body[data-ready='1']", timeout=20000)
            missing = pg.evaluate("[...document.fonts].filter(f=>f.family.includes('Cairo') && f.status==='error').length")
            if missing:
                print(f"warning: {missing} Cairo font files failed to load", file=sys.stderr)
            pg.locator("#card").screenshot(path=out)
            pg.close()
        b.close()

if __name__ == "__main__":
    src, feed, story = sys.argv[1:4]
    render(json.loads(pathlib.Path(src).read_text(encoding="utf-8")), feed, story)
    print("ok", feed, story)
