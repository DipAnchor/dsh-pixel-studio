"""Aseprite CLI - Palette management.

Palettes are the artist's color vocabulary. An agent should pick a
small, deliberate palette per piece (like a human artist) instead of
ad-hoc colors everywhere.
"""

from typing import Any, Dict, List

from .model import _t, normalize_color, hex_to_rgba, rgba_to_hex

# Classic pixel-art palettes (name -> list of (name, hex))
CLASSIC_PALETTES: Dict[str, List[tuple]] = {
    "pico8": [
        ("black", "#000000"), ("dark-blue", "#1D2B53"), ("dark-purple", "#7E2553"),
        ("dark-green", "#008751"), ("brown", "#AB5236"), ("dark-gray", "#5F574F"),
        ("light-gray", "#C2C3C7"), ("white", "#FFF1E8"), ("red", "#FF004D"),
        ("orange", "#FFA300"), ("yellow", "#FFEC27"), ("green", "#00E436"),
        ("blue", "#29ADFF"), ("indigo", "#83769C"), ("pink", "#FF77A8"),
        ("peach", "#FFCCAA"),
    ],
    "db16": [
        ("black", "#140c1c"), ("dark-purple", "#442434"), ("dark-blue", "#30346d"),
        ("brown", "#4e4a4e"), ("dark-green", "#854c30"), ("dark-gray", "#346524"),
        ("mid-gray", "#d04648"), ("light-gray", "#757161"), ("red", "#597dce"),
        ("orange", "#d27d2c"), ("yellow", "#8595a1"), ("green", "#6daa2c"),
        ("blue", "#d2aa99"), ("indigo", "#6dc2ca"), ("pink", "#dad45e"),
        ("peach", "#deeed6"),
    ],
    "sweetie16": [
        ("black", "#1a1c2c"), ("dark-blue", "#5d275d"), ("dark-purple", "#b13e53"),
        ("dark-green", "#ef7d57"), ("brown", "#ffcd75"), ("dark-gray", "#a7f070"),
        ("light-gray", "#38b764"), ("white", "#257179"), ("red", "#29366f"),
        ("orange", "#3b5dc9"), ("yellow", "#41a6f6"), ("green", "#73eff7"),
        ("blue", "#f4f4f4"), ("indigo", "#94b0c2"), ("pink", "#566c86"),
        ("peach", "#333c57"),
    ],
    "na16": [
        ("black", "#000000"), ("dark-blue", "#222034"), ("mid-blue", "#45283c"),
        ("brown", "#663931"), ("dark-red", "#8f563b"), ("tan", "#df7126"),
        ("light-tan", "#d9a066"), ("yellow", "#eec39a"), ("light-yellow", "#fbf236"),
        ("light-green", "#99e550"), ("green", "#6abe30"), ("dark-green", "#37946e"),
        ("light-cyan", "#4b692f"), ("cyan", "#524b24"), ("blue-gray", "#323c39"),
        ("light-gray", "#3f3f74"),
    ],
}


def list_palettes() -> Dict[str, Any]:
    return {"palettes": list(CLASSIC_PALETTES.keys()), "count": len(CLASSIC_PALETTES)}


def apply_palette(doc, name: str) -> dict:
    if name not in CLASSIC_PALETTES:
        raise ValueError(f"unknown palette '{name}', available: {list(CLASSIC_PALETTES)}")
    entries = CLASSIC_PALETTES[name]
    doc["palette"] = [
        {"index": i, "name": nm, "color": normalize_color(col)}
        for i, (nm, col) in enumerate(entries)
    ]
    _t(doc)
    return {"palette": name, "colors": len(entries)}


def add_color(doc, name: str, color: str) -> dict:
    color = normalize_color(color)
    if any(c["name"] == name for c in doc["palette"]):
        raise ValueError(f"palette already has color named '{name}'")
    idx = len(doc["palette"])
    doc["palette"].append({"index": idx, "name": name, "color": color})
    _t(doc)
    return {"index": idx, "name": name, "color": color}


def rename_color(doc, index: int, new_name: str) -> dict:
    for c in doc["palette"]:
        if c["index"] == int(index):
            old = c["name"]
            c["name"] = new_name
            _t(doc)
            return {"index": int(index), "old_name": old, "new_name": new_name}
    raise ValueError(f"no palette color at index {index}")


def nearest_color(doc, color: str) -> Dict[str, Any]:
    """Map an arbitrary color to the nearest palette entry (for quantization)."""
    r, g, b, a = hex_to_rgba(color)
    best, best_d = None, None
    for c in doc["palette"]:
        pr, pg, pb, pa = hex_to_rgba(c["color"])
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2 + (a - pa) ** 2
        if best_d is None or d < best_d:
            best, best_d = c, d
    return {"nearest": best["name"], "color": best["color"], "distance": best_d}


def quantize_canvas(doc, layer_id=None) -> dict:
    """Snap every pixel in the current cel to the nearest palette color."""
    from .model import get_cel, hex_to_rgba
    cel = get_cel(doc, layer_id)
    n = 0
    for key in list(cel.keys()):
        r, g, b, a = hex_to_rgba(cel[key])
        if a == 0:
            continue
        best, best_d = None, None
        for c in doc["palette"]:
            pr, pg, pb, pa = hex_to_rgba(c["color"])
            d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
            if best_d is None or d < best_d:
                best, best_d = c["color"], d
        if best is not None and best != cel[key]:
            cel[key] = best
            n += 1
    _t(doc) if n else None
    return {"quantized": n, "palette_size": len(doc["palette"])}
