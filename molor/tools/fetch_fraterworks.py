#!/usr/bin/env python3
"""
Build a complete snapshot of the Fraterworks catalogue for molor.

Routes (all permitted by https://fraterworks.com/robots.txt):

  json  (default)  GET /products.json?limit=250&page=N
                   6 requests for ~1.4k products. Full variants, tags,
                   product_type, vendor, body_html. This is the cheap path.

  mcp   (optional) UCP MCP https://frater-factory.myshopify.com/api/ucp/mcp
                   tools: search_catalog / get_product, discovered via
                   /.well-known/ucp as described in /agents.md.
                   NOTE: aggressively rate limited - observed
                   HTTP 429 with Retry-After 757s after ~200 calls - and
                   search_catalog caps at ~215 relevance hits, so it cannot
                   enumerate the catalogue on its own.

Output: molor/data/fraterworks_catalog.json

    python molor/tools/fetch_fraterworks.py            # json crawl
    python molor/tools/fetch_fraterworks.py --sitemap-check
    python molor/tools/fetch_fraterworks.py --via mcp  # slow, rate limited
"""

from __future__ import annotations

import argparse
import html as html_mod
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

STORE = "https://fraterworks.com"
MCP_ENDPOINT = "https://frater-factory.myshopify.com/api/ucp/mcp"
DEFAULT_PROFILE = "https://valkon.us/ucp-agent.json"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "fraterworks_catalog.json"

CAS_RE = re.compile(r"\b\d{2,7}-\d{2}-\d\b")
TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
LOC_RE = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>")

UA = "valkon-molor-catalog/1.0 (+https://valkon.us)"


def plain_text(markup: str | None, limit: int = 6000) -> str:
    if not markup:
        return ""
    text = WS_RE.sub(" ", TAG_RE.sub(" ", html_mod.unescape(markup))).strip()
    return text[:limit]


def http_get(url: str, accept: str = "*/*", attempts: int = 5) -> str:
    for attempt in range(attempts):
        req = urllib.request.Request(url, headers={"user-agent": UA, "accept": accept})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            if err.code in (429, 500, 502, 503) and attempt < attempts - 1:
                retry_after = err.headers.get("Retry-After")
                delay = float(retry_after) if retry_after else 2.0 * 2**attempt
                print(f"  HTTP {err.code} - backoff {delay:.0f}s", file=sys.stderr)
                time.sleep(delay)
                continue
            raise
        except urllib.error.URLError:
            if attempt < attempts - 1:
                time.sleep(2.0 * 2**attempt + random.random())
                continue
            raise
    raise RuntimeError(f"failed: {url}")


# --------------------------------------------------------------------------- #
# normalisation
# --------------------------------------------------------------------------- #

def normalize(product: dict, source: str) -> dict:
    body = product.get("body_html") or ""
    text = plain_text(body)

    variants = []
    for variant in product.get("variants") or []:
        try:
            price = int(round(float(variant.get("price") or 0) * 100))
        except (TypeError, ValueError):
            price = None
        variants.append(
            {
                "id": variant.get("id"),
                "sku": variant.get("sku"),
                "size": variant.get("title"),
                "price": price,
                "compare_at_price": variant.get("compare_at_price"),
                "available": variant.get("available"),
                "grams": variant.get("grams"),
            }
        )

    prices = [v["price"] for v in variants if v.get("price") is not None]
    images = [img.get("src") for img in product.get("images") or [] if isinstance(img, dict)]

    return {
        "id": f"gid://shopify/Product/{product.get('id')}",
        "handle": product.get("handle"),
        "title": product.get("title"),
        "url": f"{STORE}/products/{urllib.parse.quote(product.get('handle') or '')}",
        "vendor": product.get("vendor"),
        "product_type": product.get("product_type"),
        "published_at": product.get("published_at"),
        "price_range": (
            {"min": min(prices), "max": max(prices), "currency": "USD"} if prices else {}
        ),
        "available": any(v.get("available") for v in variants),
        "in_stock_sizes": [v["size"] for v in variants if v.get("available")],
        "sold_out_sizes": [v["size"] for v in variants if not v.get("available")],
        "sku_base": sorted({(v.get("sku") or "").rsplit("-", 1)[0] for v in variants if v.get("sku")}),
        "tags": product.get("tags") or [],
        "options": [o.get("name") for o in product.get("options") or [] if isinstance(o, dict)],
        "image": images[0] if images else None,
        "variants": variants,
        # Join key against the perfumer material table.
        "cas": sorted(set(CAS_RE.findall(text))),
        "description": text[:2000],
        "source": source,
    }


def crawl_json(limit: int, pace: float) -> list[dict]:
    products: list[dict] = []
    page = 1
    while True:
        url = f"{STORE}/products.json?limit={limit}&page={page}"
        raw = http_get(url, accept="application/json")
        batch = json.loads(raw).get("products") or []
        if not batch:
            break
        for product in batch:
            products.append(normalize(product, "products.json"))
        print(f"  page {page}: +{len(batch)} -> {len(products)}", file=sys.stderr)
        if len(batch) < limit:
            break
        page += 1
        time.sleep(pace)
    return products


def crawl_mcp(limit: int, pace: float, profile: str) -> list[dict]:
    """Best-effort MCP sweep. Rate limited; will return partial data."""
    client = McpClient(profile, pace)
    seeds = [chr(c) for c in range(ord("a"), ord("z") + 1)] + [str(d) for d in range(10)]
    found: dict[str, dict] = {}
    for query in seeds:
        cursor: str | None = None
        for _ in range(6):
            try:
                payload = client.search(query, cursor, limit)
            except RuntimeError as err:
                print(f"  '{query}': {err}", file=sys.stderr)
                return list(found.values())
            for item in payload.get("products") or []:
                handle = item.get("handle")
                if handle and handle not in found:
                    found[handle] = normalize_mcp(item)
            pagination = payload.get("pagination") or {}
            cursor = pagination.get("cursor")
            if not pagination.get("has_next_page") or not cursor:
                break
            time.sleep(pace)
    return list(found.values())


def normalize_mcp(product: dict) -> dict:
    description = product.get("description") or {}
    markup = description.get("html", "") if isinstance(description, dict) else str(description)
    text = plain_text(markup)

    variants = []
    for variant in product.get("variants") or []:
        variants.append(
            {
                "id": variant.get("id"),
                "sku": variant.get("sku"),
                "size": variant.get("title"),
                "price": (variant.get("price") or {}).get("amount"),
                "available": (variant.get("availability") or {}).get("available"),
            }
        )

    return {
        "id": product.get("id"),
        "handle": product.get("handle"),
        "title": product.get("title"),
        "url": product.get("url") or f"{STORE}/products/{product.get('handle')}",
        "vendor": None,
        "product_type": None,
        "published_at": None,
        "price_range": product.get("price_range") or {},
        "available": any(v.get("available") for v in variants),
        "in_stock_sizes": [v["size"] for v in variants if v.get("available")],
        "sold_out_sizes": [v["size"] for v in variants if not v.get("available")],
        "sku_base": sorted({(v.get("sku") or "").rsplit("-", 1)[0] for v in variants if v.get("sku")}),
        "tags": product.get("tags") or [],
        "options": [o.get("name") for o in product.get("options") or [] if isinstance(o, dict)],
        "image": ((product.get("media") or [{}])[0] or {}).get("url"),
        "variants": variants,
        "cas": sorted(set(CAS_RE.findall(text))),
        "description": text[:2000],
        "source": "ucp-mcp",
    }


class McpClient:
    def __init__(self, profile: str, pace: float) -> None:
        self.profile = profile
        self.pace = pace
        self._id = 0
        self._last = 0.0

    def _throttle(self) -> None:
        wait = self.pace - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def call(self, method: str, params: dict, attempts: int = 4) -> dict:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
        for attempt in range(attempts):
            self._throttle()
            req = urllib.request.Request(
                MCP_ENDPOINT,
                data=body,
                headers={"content-type": "application/json", "accept": "application/json", "user-agent": UA},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=60) as res:
                    payload = json.loads(res.read())
            except urllib.error.HTTPError as err:
                if err.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                    retry_after = err.headers.get("Retry-After")
                    delay = float(retry_after) if retry_after else 2.0 * 2**attempt
                    print(f"  HTTP {err.code} - backoff {delay:.0f}s", file=sys.stderr)
                    if delay > 120:
                        raise RuntimeError(f"rate limited, Retry-After {delay:.0f}s")
                    time.sleep(delay)
                    continue
                raise
            except urllib.error.URLError:
                time.sleep(2.0 * 2**attempt)
                continue
            if payload.get("error"):
                data = payload["error"].get("data") or {}
                raise RuntimeError(f"{payload['error'].get('message')} [{data.get('code', '')}]")
            return payload["result"]
        raise RuntimeError("exhausted retries")

    def search(self, query: str | None, cursor: str | None, limit: int) -> dict:
        catalog: dict = {
            "pagination": {"limit": limit},
            "context": {"address_country": "US", "currency": "USD", "language": "en-US"},
        }
        if query:
            catalog["query"] = query
        if cursor:
            catalog["pagination"]["cursor"] = cursor
        result = self.call(
            "tools/call",
            {"name": "search_catalog", "arguments": {"meta": {"ucp-agent": {"profile": self.profile}}, "catalog": catalog}},
        )
        for block in result.get("content", []):
            if block.get("type") == "text":
                return json.loads(block["text"])
        raise RuntimeError("search_catalog: unparsable result")


def enrich_cas(materials: list[dict], pace: float) -> int:
    """
    /products/{handle}.js (~6 KB) exposes the CAS metafields that the rendered
    body_html and /products.json both omit. One extra request per product,
    which is cheap compared with pulling the 790 KB product page.
    """
    filled = 0
    for index, material in enumerate(materials, 1):
        if material.get("cas"):
            continue
        handle = material.get("handle")
        if not handle:
            continue
        url = f"{STORE}/products/{urllib.parse.quote(handle)}.js"
        try:
            raw = http_get(url, accept="application/json")
        except Exception as err:  # noqa: BLE001
            print(f"  [{index}] {handle}: {err}", file=sys.stderr)
            continue

        found = Counter(CAS_RE.findall(raw))
        if not found:
            continue
        # The dominant value is this product's own CAS; stray singletons are
        # usually numbers lifted from neighbouring copy.
        ranked = [cas for cas, count in found.most_common(3) if count >= 2] or [found.most_common(1)[0][0]]
        material["cas"] = sorted(ranked)
        filled += 1

        if index % 100 == 0:
            print(f"  enriched {filled} ({index}/{len(materials)})", file=sys.stderr)
        time.sleep(pace)
    return filled


def sitemap_handles() -> list[str]:
    index = http_get(f"{STORE}/sitemap.xml")
    handles: list[str] = []
    for url in LOC_RE.findall(index):
        if "/sitemap_products_" not in url:
            continue
        for loc in LOC_RE.findall(http_get(url.replace("&amp;", "&"))):
            if "/products/" in loc:
                handles.append(loc.split("/products/", 1)[1].split("?")[0].split("/")[0])
    return sorted(set(handles))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--via", choices=["json", "mcp"], default="json")
    parser.add_argument("--limit", type=int, default=250)
    parser.add_argument("--pace", type=float, default=1.5)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--out", default=str(OUT_PATH))
    parser.add_argument("--sitemap-check", action="store_true", help="reconcile against the sitemap handle list")
    parser.add_argument("--no-enrich", action="store_true", help="skip the CAS enrichment pass")
    parser.add_argument("--enrich-pace", type=float, default=0.3)
    args = parser.parse_args()

    started = time.time()
    print(f"crawl via {args.via}", file=sys.stderr)
    materials = crawl_json(args.limit, args.pace) if args.via == "json" else crawl_mcp(args.limit, args.pace, args.profile)

    if not args.no_enrich:
        print("enrich: harvesting CAS from /products/{handle}.js", file=sys.stderr)
        added = enrich_cas(materials, args.enrich_pace)
        print(f"enrich: +{added} products gained a CAS", file=sys.stderr)

    expected: list[str] = []
    unresolved: list[str] = []
    if args.sitemap_check:
        expected = sitemap_handles()
        have = {m["handle"] for m in materials}
        unresolved = [h for h in expected if h not in have]
        print(f"sitemap: {len(expected)} handles, {len(unresolved)} not in crawl", file=sys.stderr)

    materials.sort(key=lambda m: (m.get("title") or "").lower())

    doc = {
        "meta": {
            "source": "Fraterworks (fraterworks.com)",
            "via": "/products.json" if args.via == "json" else "UCP MCP search_catalog",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "elapsed_seconds": round(time.time() - started, 1),
            "count": len(materials),
            "sitemap_products": len(expected),
            "unresolved_handles": unresolved,
            "with_cas": sum(1 for m in materials if m.get("cas")),
            "in_stock": sum(1 for m in materials if m.get("available")),
            "prices_in": "integer minor currency units (USD cents); divide by 100",
            "note": "Offline snapshot - refresh occasionally, never query at runtime from a browser.",
        },
        "materials": materials,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    print(
        f"\nwrote {len(materials)} materials -> {out}\n"
        f"  with CAS : {doc['meta']['with_cas']}\n"
        f"  in stock : {doc['meta']['in_stock']}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
