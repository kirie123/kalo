#!/usr/bin/env python3
"""gn.py — Glassnode Research 公开报告拉取与归档。

纯标准库实现（无第三方依赖）。数据源：https://research.glassnode.com/（Ghost CMS）：

- RSS 全文订阅：https://research.glassnode.com/rss/（最新 15 篇，content:encoded 是完整正文）
- 历史回填：sitemap.xml → sitemap-posts.xml（英文原版约 740 篇，翻译版按首路径段过滤）
- 文章页正文在 <section class="gh-content gh-canvas">，meta 有 og:title / article:published_time

归档落点：~/.kalo/research/glassnode/
  index.json                      {guid: {slug,title,link,published,categories,file,words,images}}
  <year>/<date>-<slug>.md         正文 markdown（frontmatter + 正文，图片指向本地相对路径）
  <year>/assets/<date>-<slug>/    图表图片（img-NN.<ext>）
"""

import argparse
import email.utils
import html as html_mod
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

BASE = "https://research.glassnode.com"
RSS_URL = BASE + "/rss/"
SITEMAP_POSTS_URL = BASE + "/sitemap-posts.xml"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kalo/glassnode-research"
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}encoded"

# sitemap 里翻译版的首路径段；其余视为英文原版（含老的 /content/ 前缀文章）。
LANG_PREFIXES = {
    "cn", "chinese", "vietnamese", "french", "turkish", "spanish", "farsi",
    "polish", "japanese", "greek", "russian", "portuguese", "arabic", "es",
    "de", "german", "italian", "korean", "thai", "hindi", "indonesian",
}

MAX_PAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 30 * 1024 * 1024
HTTP_TIMEOUT = 30
IMG_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}


def archive_root():
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".kalo", "research", "glassnode")


def _ssl_context():
    """Windows 上官方/商店版 Python 常缺根证书（CERTIFICATE_VERIFY_FAILED），
    优先用 certifi 的 CA bundle；certifi 不在（纯裸环境）就用系统默认。"""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_SSL = None


def http_get(url, max_bytes=MAX_PAGE_BYTES, timeout=HTTP_TIMEOUT):
    global _SSL
    if _SSL is None:
        _SSL = _ssl_context()
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": BASE + "/",
        "Accept": "*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout, context=_SSL) as resp:
        data = resp.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise ValueError("response too large: %s" % url)
        ctype = resp.headers.get("Content-Type", "")
        return data, ctype


def decode_text(data):
    return data.decode("utf-8", errors="replace")


# ---------------------------------------------------------------- RSS 解析

def parse_rss(xml_bytes):
    root = ET.fromstring(xml_bytes)
    items = []
    for it in root.iter("item"):
        content = it.findtext(CONTENT_NS) or ""
        pub_raw = it.findtext("pubDate") or ""
        try:
            published = email.utils.parsedate_to_datetime(pub_raw).isoformat()
        except (TypeError, ValueError):
            published = pub_raw
        link = (it.findtext("link") or "").strip()
        items.append({
            "guid": (it.findtext("guid") or link).strip(),
            "title": (it.findtext("title") or "").strip(),
            "link": link,
            "published": published,
            "categories": [c.text.strip() for c in it.findall("category") if c.text],
            "html": content,
        })
    return items


# ------------------------------------------------------------ HTML → markdown

class MdConverter(HTMLParser):
    """够用就行的 HTML→markdown 转换：标题/段落/列表/引用/链接/图片/表格。

    产出给 LLM 读，不追求排版精确。图片保留原始 URL，由调用方下载后替换。
    """

    BLOCK_TAGS = {"p", "div", "section", "article", "figure", "header", "table"}
    SKIP_TAGS = {"script", "style", "noscript", "svg", "button", "form"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.buf = []
        self.skip_depth = 0
        self.pre = False
        self.list_stack = []          # ('ul'|'ol', count)
        self.link_stack = []          # (href, emitted_bracket)
        self.images = []              # 有序去重的图片 URL
        self._tr_cells = 0

    # -- 输出辅助：保证块级元素之间有空行
    def _tail(self, n):
        return "".join(self.buf)[-n:] if self.buf else ""

    def _ensure_blank(self):
        if not self.buf:
            return
        tail = self._tail(2)
        if tail == "\n\n":
            return
        self.buf.append("\n" if tail.endswith("\n") else "\n\n")

    def _emit(self, text):
        self.buf.append(text)

    def _add_image(self, src, alt):
        if src not in self.images:
            self.images.append(src)
        self._ensure_blank()
        self._emit("![%s](%s)" % (alt.replace("[", "(").replace("]", ")"), src))
        self._ensure_blank()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.BLOCK_TAGS:
            self._ensure_blank()
        elif tag == "br":
            self._emit("\n")
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._ensure_blank()
            self._emit("#" * min(int(tag[1]) + 1, 6) + " ")
        elif tag in ("ul", "ol"):
            self._ensure_blank()
            self.list_stack.append([tag, 0])
        elif tag == "li":
            if self.list_stack:
                self.list_stack[-1][1] += 1
                kind, n = self.list_stack[-1]
                marker = "%d. " % n if kind == "ol" else "- "
                indent = "  " * (len(self.list_stack) - 1)
            else:
                marker, indent = "- ", ""
            if self.buf and not self._tail(1) == "\n":
                self._emit("\n")
            self._emit(indent + marker)
        elif tag == "blockquote":
            self._ensure_blank()
            self._emit("> ")
        elif tag == "pre":
            self._ensure_blank()
            self._emit("```\n")
            self.pre = True
        elif tag == "code" and not self.pre:
            self._emit("`")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i"):
            self._emit("*")
        elif tag == "figcaption":
            self._ensure_blank()
            self._emit("*")
        elif tag == "a":
            href = (attrs.get("href") or "").strip()
            if href:
                self._emit("[")
                self.link_stack.append((href, True))
            else:
                self.link_stack.append((None, False))
        elif tag == "img":
            cls = attrs.get("class") or ""
            if "author-profile" in cls:
                return
            src = attrs.get("src") or attrs.get("data-src") or ""
            if src.startswith("http"):
                self._add_image(src, attrs.get("alt") or "chart")
        elif tag == "hr":
            self._ensure_blank()
            self._emit("---")
            self._ensure_blank()
        elif tag == "tr":
            self._tr_cells = 0
            if self.buf and not self._tail(1) == "\n":
                self._emit("\n")
        elif tag in ("td", "th"):
            if self._tr_cells:
                self._emit(" | ")
            self._tr_cells += 1

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self.BLOCK_TAGS or tag in ("h1", "h2", "h3", "h4", "h5", "h6",
                                             "li", "blockquote"):
            self._ensure_blank()
        elif tag == "figcaption":
            self._emit("*")
            self._ensure_blank()
        elif tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
            self._ensure_blank()
        elif tag == "pre":
            self._emit("\n```")
            self._ensure_blank()
            self.pre = False
        elif tag == "code" and not self.pre:
            self._emit("`")
        elif tag in ("strong", "b"):
            self._emit("**")
        elif tag in ("em", "i", "figcaption"):
            self._emit("*")
        elif tag == "a":
            if self.link_stack:
                href, emitted = self.link_stack.pop()
                if emitted:
                    self._emit("](%s)" % href)
        elif tag == "tr":
            self._emit(" |")

    def handle_data(self, data):
        if self.skip_depth:
            return
        if self.pre:
            self._emit(data)
        else:
            self._emit(re.sub(r"\s+", " ", data))

    def markdown(self):
        text = "".join(self.buf)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def html_to_markdown(html_text):
    conv = MdConverter()
    conv.feed(html_text)
    conv.close()
    return conv.markdown(), conv.images


# ------------------------------------------------------------------ 归档存储

def load_index(root):
    try:
        with open(os.path.join(root, "index.json"), encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and isinstance(data.get("posts"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "posts": {}}


def save_index(root, index):
    tmp = os.path.join(root, "index.json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, os.path.join(root, "index.json"))


def slugify(link, guid):
    slug = link.rstrip("/").rsplit("/", 1)[-1] if link else ""
    slug = re.sub(r"[^a-z0-9-]", "", slug.lower().replace("_", "-"))
    slug = re.sub(r"-{2,}", "-", slug).strip("-")[:80]
    if not slug:
        slug = "post-" + re.sub(r"[^a-z0-9]", "", guid.lower())[:12]
    return slug


def image_ext(url, ctype):
    ext = os.path.splitext(url.split("?")[0])[1].lower()
    if ext in IMG_EXTS:
        return ext
    return {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
            "image/webp": ".webp", "image/svg+xml": ".svg"}.get(ctype.split(";")[0], ".png")


def store_post(root, index, meta, body_html, with_images=True, img_delay=0.2):
    """落盘一篇：markdown + 图片 + index。返回 (entry, error_or_None)。"""
    guid, link = meta["guid"], meta["link"]
    slug = slugify(link, guid)
    date = (meta.get("published") or "")[:10] or "unknown-date"
    year = date[:4] if re.match(r"\d{4}", date) else "undated"

    md_text, img_urls = html_to_markdown(body_html)
    base = "%s-%s" % (date, slug)

    replacements = {}
    saved_images = []
    if with_images and img_urls:
        assets_dir = os.path.join(root, year, "assets", base)
        url_to_name = {}
        for url in img_urls:
            if url not in url_to_name:
                url_to_name[url] = "img-%02d%s" % (len(url_to_name) + 1, ".tmp")
        for url, name_tpl in url_to_name.items():
            try:
                data, ctype = http_get(url, max_bytes=MAX_IMAGE_BYTES)
                name = name_tpl.replace(".tmp", image_ext(url, ctype))
                os.makedirs(assets_dir, exist_ok=True)
                with open(os.path.join(assets_dir, name), "wb") as f:
                    f.write(data)
                replacements[url] = "assets/%s/%s" % (base, name)
                saved_images.append(replacements[url])
                time.sleep(img_delay)
            except (urllib.error.URLError, ValueError, OSError, TimeoutError):
                pass  # 图挂了保留原始 URL，不挡正文落盘
        for url, rel in replacements.items():
            md_text = md_text.replace("](%s)" % url, "](%s)" % rel)

    words = len(md_text.split())
    fm = {
        "title": meta.get("title") or slug,
        "link": link,
        "published": meta.get("published") or "",
        "categories": meta.get("categories") or [],
        "guid": guid,
        "words": words,
        "images": len(saved_images),
    }
    fm_lines = ["---"]
    for k, v in fm.items():
        fm_lines.append("%s: %s" % (k, json.dumps(v, ensure_ascii=False)))
    fm_lines.append("---")
    doc = "\n".join(fm_lines) + "\n\n# %s\n\n> 原文：%s\n\n%s\n" % (
        fm["title"], link, md_text)

    year_dir = os.path.join(root, year)
    os.makedirs(year_dir, exist_ok=True)
    fname = base + ".md"
    existing = index["posts"].get(guid)
    if existing and existing.get("file"):
        fname = os.path.basename(existing["file"])
    path = os.path.join(year_dir, fname)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(doc)

    entry = dict(fm)
    entry["slug"] = slug
    entry["file"] = "%s/%s" % (year, fname)
    entry["fetched_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    index["posts"][guid] = entry
    return entry, None


# ------------------------------------------------------------------- 页面回填

def extract_article(page_html):
    """从文章页提取 {title, published, categories, html}；失败返回 None。"""
    def meta(prop):
        m = re.search(
            r'<meta[^>]+property=["\']%s["\'][^>]+content=["\']([^"\']*)["\']' % re.escape(prop),
            page_html)
        if not m:
            m = re.search(
                r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']%s["\']' % re.escape(prop),
                page_html)
        return html_mod.unescape(m.group(1)) if m else ""

    m = re.search(r'<section[^>]+class=["\'][^"\']*gh-content[^"\']*["\'][^>]*>', page_html)
    if not m:
        return None
    depth, end = 0, len(page_html)
    for mm in re.finditer(r"<section[^>]*>|</section>", page_html[m.start():]):
        if mm.group(0).startswith("</"):
            depth -= 1
        else:
            depth += 1
        if depth == 0:
            end = m.start() + mm.end()
            break
    body = page_html[m.start():end]
    # 文章自己的栏目链接是相对路径且带尾斜杠（/tag/newsletter/ → "The Week On-chain"）；
    # 语言切换器是绝对 URL 或无尾斜杠（/tag/spanish），据此区分。
    tags = []
    for tm in re.finditer(
            r"<a[^>]+href=[\"']/tag/[a-z-]+/[\"'][^>]*>([^<]+)</a>", page_html):
        text = html_mod.unescape(tm.group(1)).strip()
        if text and text not in tags:
            tags.append(text)
    return {
        "title": meta("og:title"),
        "published": meta("article:published_time"),
        "categories": tags,
        "html": body,
    }


# --------------------------------------------------------------------- 命令

def cmd_pull(args):
    try:
        data, _ = http_get(args.rss or RSS_URL)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError) as e:
        return _fail(args, "rss fetch failed: %s" % e)
    try:
        items = parse_rss(data)
    except ET.ParseError as e:
        return _fail(args, "rss parse failed: %s" % e)

    root = archive_root()
    index = load_index(root)
    known_links = {p.get("link") for p in index["posts"].values()}
    new, errors = [], []
    for item in sorted(items, key=lambda x: x.get("published") or ""):
        if not args.force and (item["guid"] in index["posts"] or item["link"] in known_links):
            continue
        try:
            entry, _ = store_post(root, index, item, item["html"],
                                  with_images=not args.no_images)
            new.append({"title": entry["title"], "file": entry["file"],
                        "categories": entry["categories"]})
        except OSError as e:
            errors.append({"title": item["title"], "error": str(e)})
    if new or errors or args.force:
        save_index(root, index)

    fatal = errors and not new and len(errors) >= len(items)
    if not args.quiet or fatal:
        _print_json({"new": new, "skipped": len(items) - len(new) - len(errors),
                     "errors": errors, "archive": root})
    return 1 if fatal else 0


def cmd_backfill(args):
    try:
        data, _ = http_get(SITEMAP_POSTS_URL)
    except (urllib.error.URLError, ValueError, OSError, TimeoutError) as e:
        return _fail(args, "sitemap fetch failed: %s" % e)
    urls = re.findall(r"<loc>([^<]+)</loc>", decode_text(data))
    urls = [u for u in urls
            if u.replace(BASE, "").strip("/").split("/")[0] not in LANG_PREFIXES]

    root = archive_root()
    index = load_index(root)
    known_links = {p.get("link") for p in index["posts"].values()}
    todo = [u for u in urls if u not in known_links]
    pending_total = len(todo)
    if args.limit:
        todo = todo[:args.limit]

    done, errors = [], []
    for i, url in enumerate(todo):
        try:
            page, _ = http_get(url)
            art = extract_article(decode_text(page))
            if not art or not art["html"]:
                errors.append({"url": url, "error": "no gh-content section"})
                continue
            art["guid"] = url  # 回填没有 RSS guid，用 canonical link 兜底
            art["link"] = url
            entry, _ = store_post(root, index, art, art["html"],
                                  with_images=not args.no_images)
            done.append(entry["file"])
        except (urllib.error.URLError, ValueError, OSError, TimeoutError) as e:
            errors.append({"url": url, "error": str(e)})
        if i % 10 == 9:
            save_index(root, index)
        time.sleep(args.delay)
    save_index(root, index)
    _print_json({"fetched": len(done), "remaining": pending_total - len(done),
                 "errors": errors[:10], "archive": root})
    return 0 if done or not errors else 1


def cmd_list(args):
    root = archive_root()
    index = load_index(root)
    posts = list(index["posts"].values())
    if args.category:
        needle = args.category.lower()
        posts = [p for p in posts
                 if any(needle in (c or "").lower() for c in p.get("categories", []))]
    posts.sort(key=lambda p: p.get("published") or "", reverse=True)
    posts = posts[:args.limit]
    _print_json([{k: p.get(k) for k in
                  ("published", "title", "categories", "file", "words", "images")}
                 for p in posts])
    return 0


def cmd_path(args):
    root = archive_root()
    index = load_index(root)
    needle = args.slug.lower()
    for p in index["posts"].values():
        if needle in (p.get("slug") or "").lower() or needle in p.get("file", "").lower():
            print(os.path.join(root, p["file"].replace("/", os.sep)))
            return 0
    print("not found: %s" % args.slug, file=sys.stderr)
    return 1


def cmd_doctor(args):
    root = archive_root()
    index = load_index(root)
    posts = list(index["posts"].values())
    total_md = sum(p.get("words", 0) for p in posts)
    print("python        : %s" % sys.version.split()[0])
    print("archive       : %s" % root)
    print("archived posts: %d (约 %d 词)" % (len(posts), total_md))
    try:
        t0 = time.time()
        data, _ = http_get(RSS_URL)
        items = parse_rss(data)
        print("network       : ok (rss %d items, %.1fs)" % (len(items), time.time() - t0))
        latest = max(items, key=lambda x: x.get("published") or "")
        print("latest on rss : %s (%s)" % (latest["title"], latest["published"][:10]))
    except (urllib.error.URLError, ValueError, OSError, TimeoutError,
            ET.ParseError) as e:
        print("network       : FAIL %s" % e)
        return 1
    return 0


# --------------------------------------------------------------------- 入口

def _print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))


def _fail(args, msg):
    # --quiet 的契约（同 market-data 的 macro append）：静默仅限一切正常；
    # 失败必须说话，挂 scheduler watch 时 stdout 非空即异常。
    if getattr(args, "quiet", False):
        print(msg)
    else:
        _print_json({"error": msg})
    return 1


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(
        prog="gn.py", description="Glassnode Research 公开报告拉取与归档")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("pull", help="拉 RSS，归档新篇（幂等）")
    p.add_argument("--quiet", action="store_true", help="成功时静默（scheduler watch 用）")
    p.add_argument("--force", action="store_true", help="已归档的也重新拉取覆盖")
    p.add_argument("--no-images", action="store_true", help="不下载图表图片")
    p.add_argument("--rss", help="覆盖 RSS URL（调试用）")
    p.set_defaults(fn=cmd_pull)

    p = sub.add_parser("backfill", help="走 sitemap 回填历史英文原版")
    p.add_argument("--limit", type=int, default=100, help="最多回填几篇（默认 100，0=不限）")
    p.add_argument("--delay", type=float, default=1.0, help="每篇间隔秒数（默认 1.0）")
    p.add_argument("--no-images", action="store_true")
    p.set_defaults(fn=cmd_backfill)

    p = sub.add_parser("list", help="列出本地归档（JSON）")
    p.add_argument("--category", help="按栏目名过滤（子串、不区分大小写）")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("path", help="按 slug 子串查某篇的本地路径")
    p.add_argument("slug")
    p.set_defaults(fn=cmd_path)

    p = sub.add_parser("doctor", help="环境自检")
    p.set_defaults(fn=cmd_doctor)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
