#!/usr/bin/env python3
"""
Find Fraterworks materials that are NOT yet in the perfumer material list.

    python molor/tools/diff_fraterworks.py
    python molor/tools/diff_fraterworks.py --csv "C:/Valle/dev/perfumer/docs/usable-materials-cas.csv"

Matching is CAS-first (authoritative), then by normalised name / token subset,
because supplier titles are free text: "Ambroxan (R) Crystals", "Ambrox DL",
"Ambroxide" all describe the same material.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path

CATALOG = Path(__file__).resolve().parent.parent / "data" / "fraterworks_catalog.json"
DEFAULT_CSV = Path("C:/Valle/dev/perfumer/docs/usable-materials-cas.csv")
OUT = Path(__file__).resolve().parent.parent / "data" / "fraterworks_missing.json"

CAS_RE = re.compile(r"\b\d{2,7}-\d{2}-\d\b")
NOISE_RE = re.compile(r"[\u00ae\u2122\u00a9\u2120]")
NON_ALNUM = re.compile(r"[^a-z0-9]+")

# Words that carry no identifying information in a supplier title.
STOP = {
    "the", "and", "of", "type", "grade", "natural", "synthetic", "pure",
    "crystals", "crystal", "liquid", "powder", "solution", "dilution",
    "base", "specialty", "speciality", "coeur", "heart", "extra", "select",
    "selected", "premium", "quality", "concentrate", "concentrated",
    "firmenich", "givaudan", "symrise", "iff", "mane", "takasago", "robertet",
    "drom", "firmenichs", "givaudans",
}


def norm_name(value: str) -> str:
    text = NOISE_RE.sub(" ", (value or "").lower())
    text = text.replace("&", " and ")
    text = NON_ALNUM.sub(" ", text)
    return " ".join(t for t in text.split() if t)


def name_tokens(value: str) -> set[str]:
    return {t for t in norm_name(value).split() if t not in STOP and len(t) > 1}


def norm_cas(value: str) -> str | None:
    match = CAS_RE.search(value or "")
    return match.group(0) if match else None


def load_existing(path: Path) -> tuple[dict[str, str], dict[str, str], list[dict]]:
    by_cas: dict[str, str] = {}
    by_name: dict[str, str] = {}
    rows: list[dict] = []

    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise SystemExit(f"{path}: no header row")
        lowered = {f.lower().strip(): f for f in reader.fieldnames}
        name_field = lowered.get("name") or list(reader.fieldnames)[0]
        cas_field = lowered.get("cas") or (list(reader.fieldnames)[1] if len(reader.fieldnames) > 1 else None)

        for row in reader:
            name = (row.get(name_field) or "").strip()
            cas = norm_cas(row.get(cas_field)) if cas_field else None
            if not name and not cas:
                continue
            rows.append({"name": name, "cas": cas})
            if cas:
                by_cas.setdefault(cas, name)
            if name:
                by_name.setdefault(norm_name(name), name)

    return by_cas, by_name, rows


def find_match(material: dict, by_cas: dict[str, str], by_name: dict[str, str]) -> dict | None:
    # 1. CAS from the description text.
    for cas in material.get("cas") or []:
        if cas in by_cas:
            return {"via": "cas", "cas": cas, "existing": by_cas[cas]}

    title = material.get("title") or ""
    flat = norm_name(title)

    # 2. Exact normalised name.
    if flat in by_name:
        return {"via": "name", "existing": by_name[flat]}

    # 3. Token subset either way: "rose oxide l" vs "rose oxide".
    tokens = name_tokens(title)
    if tokens:
        for existing_flat, existing_name in by_name.items():
            existing_tokens = set(existing_flat.split())
            if tokens <= existing_tokens or existing_tokens <= tokens:
                return {"via": "tokens", "existing": existing_name}

    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--csv", default=str(DEFAULT_CSV))
    parser.add_argument("--catalog", default=str(CATALOG))
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--summary", action="store_true", help="print breakdowns by product_type and tag")
    parser.add_argument(
        "--types",
        default="Aromachem,Isolate",
        help="product_type values treated as aroma chemicals (comma separated; '' = all)",
    )
    args = parser.parse_args()

    catalog_doc = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    materials = catalog_doc.get("materials") or []
    by_cas, by_name, rows = load_existing(Path(args.csv))

    missing: list[dict] = []
    matched: list[dict] = []
    counts = {"cas": 0, "name": 0, "tokens": 0}

    for material in materials:
        hit = find_match(material, by_cas, by_name)
        if hit:
            counts[hit["via"]] += 1
            matched.append(
                {
                    "catalog_title": material.get("title"),
                    "existing": hit["existing"],
                    "via": hit["via"],
                    "cas": hit.get("cas"),
                    "url": material.get("url"),
                }
            )
        else:
            missing.append(material)

    missing.sort(key=lambda m: (m.get("title") or "").lower())

    wanted = {t.strip().lower() for t in (args.types or "").split(",") if t.strip()}
    chemicals = [m for m in missing if not wanted or (m.get("product_type") or "").lower() in wanted]
    other = [m for m in missing if wanted and (m.get("product_type") or "").lower() not in wanted]

    doc = {
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "catalog_snapshot": str(args.catalog),
            "catalog_generated_at": (catalog_doc.get("meta") or {}).get("generated_at"),
            "catalog_products": len(materials),
            "existing_csv": str(args.csv),
            "existing_rows": len(rows),
            "existing_with_cas": len(by_cas),
            "matched": len(matched),
            "matched_by": counts,
            "missing": len(missing),
            "missing_aroma_chemicals": len(chemicals),
            "missing_other": len(other),
            "missing_in_stock": sum(1 for m in missing if m.get("available")),
            "missing_with_cas": sum(1 for m in missing if m.get("cas")),
            "type_filter": sorted(wanted),
            "note": (
                "matched_by.cas is authoritative. 'name' is an exact normalised title match; "
                "'tokens' is a token-subset heuristic and may hide a genuinely distinct material "
                "with a similar name - review that bucket before trusting 'missing'. "
                "CAS coverage in the snapshot is ~75% (harvested from /products/{handle}.js metafields); "
                "products with no CAS fall back to name matching, so a handful of duplicates may remain."
            ),
        },
        "missing": chemicals,
        "missing_other": other,
        "matched": matched,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")

    print(f"catalog: {len(materials)} products")
    print(f"existing: {len(rows)} rows ({len(by_cas)} with CAS)")
    print(f"matched: {len(matched)}  (cas {counts['cas']}, name {counts['name']}, tokens {counts['tokens']})")
    print(f"MISSING: {len(missing)}  ({doc['meta']['missing_in_stock']} in stock)")
    print(f"  aroma chemicals only ({args.types}): {len(chemicals)}")
    print(f"  other (naturals/bases/etc):          {len(other)}")

    if args.summary:
        for label, subset in (("ALL", materials), ("MISSING", missing)):
            print(f"\n{label} by product_type:")
            for value, count in Counter(m.get("product_type") or "(none)" for m in subset).most_common(15):
                print(f"  {count:5d}  {value}")
        print("\nMISSING by tag (top 30):")
        tags = Counter(t for m in missing for t in (m.get("tags") or []))
        for value, count in tags.most_common(30):
            print(f"  {count:5d}  {value}")

    csv_path = out.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            ["name", "cas", "product_type", "in_stock", "sizes_available", "price_min_usd", "price_max_usd", "url", "tags"]
        )
        for material in chemicals:
            price = material.get("price_range") or {}
            writer.writerow(
                [
                    material.get("title"),
                    ";".join(material.get("cas") or []),
                    material.get("product_type"),
                    "yes" if material.get("available") else "no",
                    " ".join(material.get("in_stock_sizes") or []),
                    (price.get("min") or "") and f"{price['min'] / 100:.2f}",
                    (price.get("max") or "") and f"{price['max'] / 100:.2f}",
                    material.get("url"),
                    ";".join(material.get("tags") or []),
                ]
            )

    print(f"wrote -> {csv_path}", file=sys.stderr)
    print(f"wrote -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
