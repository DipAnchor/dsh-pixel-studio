"""Aseprite CLI - Pixel art document model.

The core state is a JSON-serializable dictionary (a "document") that
mirrors Aseprite's data model: sprite (width/height/color mode),
palette, layers, and frames holding cels. Cels are stored as sparse
dictionaries mapping "x,y" -> "rrggbbaa" (compact and JSON-safe).
"""

import copy
import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

DOC_VERSION = "1.0.0"

# Preset canvas sizes (name -> (w, h)) — user picks any size <= 1024x1024,
# or one of these curated presets.
CANVAS_PRESETS = {
    "icon": (16, 16),       # game icon / emoji
    "sprite": (32, 32),     # classic sprite
    "avatar": (64, 64),     # profile avatar
    "portrait": (128, 128), # character portrait
    "scene": (256, 256),    # full scene
    "wide": (512, 512),     # big canvas
    "max": (1024, 1024),    # harness limit
}
DEFAULT_PALETTE = [
    ("black", "#1a1c2c"), ("dark-blue", "#5d275d"), ("dark-purple", "#b13e53"),
    ("dark-green", "#ef7d57"), ("brown", "#ffcd75"), ("dark-gray", "#a7f070"),
    ("light-gray", "#38b764"), ("white", "#257179"), ("red", "#29366f"),
    ("orange", "#3b5dc9"), ("yellow", "#41a6f6"), ("green", "#73eff7"),
    ("blue", "#f4f4f4"), ("indigo", "#94b0c2"), ("pink", "#566c86"),
    ("peach", "#333c57"),
]


def now_iso() -> str:
    """Return current UTC time as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def new_document(width: int = 32, height: int = 32, name: str = "untitled",
                 palette: Optional[List[Tuple[str, str]]] = None) -> Dict[str, Any]:
    """Create a fresh pixel-art document."""
    if not (1 <= width <= 1024 and 1 <= height <= 1024):
        raise ValueError(f"canvas must be 1..1024 px, got {width}x{height}")
    pal = palette or DEFAULT_PALETTE
    return {
        "doc_version": DOC_VERSION,
        "name": name,
        "width": width,
        "height": height,
        "color_mode": "rgba",
        "palette": [
            {"index": i, "name": nm, "color": col} for i, (nm, col) in enumerate(pal)
        ],
        "layers": [
            {"id": 0, "name": "base", "visible": True, "opacity": 255},
        ],
        "frames": [
            {"id": 0, "duration": 100, "cels": {"0": {}}},
        ],
        "current_frame": 0,
        "current_layer": 0,
        "created": now_iso(),
        "modified": now_iso(),
    }


def _t(doc: Dict[str, Any]) -> None:
    doc["modified"] = now_iso()


def get_layer(doc: Dict[str, Any], layer_id: Optional[int] = None) -> Dict[str, Any]:
    layer_id = doc["current_layer"] if layer_id is None else layer_id
    for layer in doc["layers"]:
        if layer["id"] == layer_id:
            return layer
    raise ValueError(f"no such layer: {layer_id}")


def get_frame(doc: Dict[str, Any], frame_id: Optional[int] = None) -> Dict[str, Any]:
    frame_id = doc["current_frame"] if frame_id is None else frame_id
    for frame in doc["frames"]:
        if frame["id"] == frame_id:
            return frame
    raise ValueError(f"no such frame: {frame_id}")


def get_cel(doc: Dict[str, Any], layer_id: Optional[int] = None,
            frame_id: Optional[int] = None) -> Dict[str, str]:
    """Return the sparse cel dict for (layer, frame)."""
    frame = get_frame(doc, frame_id)
    layer_id = doc["current_layer"] if layer_id is None else layer_id
    key = str(layer_id)
    if key not in frame["cels"]:
        frame["cels"][key] = {}
    return frame["cels"][key]


def pixel_at(doc: Dict[str, Any], x: int, y: int,
             layer_id: Optional[int] = None) -> Optional[str]:
    """Get color at (x,y) in current cel, or None if transparent."""
    cel = get_cel(doc, layer_id)
    return cel.get(f"{x},{y}")


def set_pixel(doc: Dict[str, Any], x: int, y: int, color: Optional[str],
              layer_id: Optional[int] = None) -> bool:
    """Set pixel color (None erases). Returns True if changed."""
    check_bounds(doc, x, y)
    cel = get_cel(doc, layer_id)
    key = f"{x},{y}"
    if color is None:
        if key in cel:
            del cel[key]
            _t(doc)
            return True
        return False
    color = normalize_color(color)
    if cel.get(key) != color:
        cel[key] = color
        _t(doc)
        return True
    return False


def check_bounds(doc: Dict[str, Any], x: int, y: int) -> None:
    if not (0 <= x < doc["width"] and 0 <= y < doc["height"]):
        raise ValueError(f"pixel ({x},{y}) out of bounds {doc['width']}x{doc['height']}")


def normalize_color(color: str) -> str:
    """Accept #rgb, #rrggbb, #rrggbbaa, named css colors, and rgb16:r,g,b
    (16x16x16 = 4096-color indexed RGB, channels 0..15) -> #rrggbbaa."""
    color = color.strip().lower()
    if color.startswith("rgb16:"):
        parts = color[6:].split(",")
        if len(parts) != 3:
            raise ValueError(f"rgb16 color needs 3 channels, got: {color}")
        vals = []
        for p in parts:
            v = int(p.strip())
            if not (0 <= v <= 15):
                raise ValueError(f"rgb16 channel must be 0..15, got {v}")
            vals.append(v)
        return "#{:02x}{:02x}{:02x}ff".format(
            *(v * 255 // 15 for v in vals))
    if color.startswith("#"):
        c = color[1:]
        if len(c) == 3:
            c = "".join(ch * 2 for ch in c) + "ff"
        elif len(c) == 4:
            c = "".join(ch * 2 for ch in c)
        elif len(c) == 6:
            c = c + "ff"
        elif len(c) == 8:
            pass
        else:
            raise ValueError(f"invalid hex color: {color}")
        return "#" + c
    # named css colors
    from .colors import CSS_COLORS
    if color in CSS_COLORS:
        return CSS_COLORS[color]
    raise ValueError(f"unknown color: {color}")


def hex_to_rgba(color: str) -> Tuple[int, int, int, int]:
    color = normalize_color(color)
    c = color[1:]
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), int(c[6:8], 16))


def rgba_to_hex(r: int, g: int, b: int, a: int = 255) -> str:
    return "#{:02x}{:02x}{:02x}{:02x}".format(r & 255, g & 255, b & 255, a & 255)


def snapshot(doc: Dict[str, Any]) -> str:
    """Deep, JSON-safe snapshot of the document for undo stacks."""
    return json.dumps(doc, sort_keys=True)


def restore(doc: Dict[str, Any], snap: str) -> None:
    """Restore document from a snapshot string (in place)."""
    doc.clear()
    doc.update(json.loads(snap))


def add_layer(doc: Dict[str, Any], name: str = "layer") -> Dict[str, Any]:
    ids = [l["id"] for l in doc["layers"]]
    layer_id = max(ids) + 1 if ids else 0
    layer = {"id": layer_id, "name": name, "visible": True, "opacity": 255}
    doc["layers"].append(layer)
    doc["current_layer"] = layer_id
    _t(doc)
    return layer


def add_frame(doc: Dict[str, Any], duration: int = 100) -> Dict[str, Any]:
    ids = [f["id"] for f in doc["frames"]]
    frame_id = max(ids) + 1 if ids else 0
    frame = {"id": frame_id, "duration": duration, "cels": {}}
    # copy previous frame cels (onion-friendly default)
    prev = get_frame(doc)
    for layer in doc["layers"]:
        key = str(layer["id"])
        if key in prev["cels"]:
            frame["cels"][key] = dict(prev["cels"][key])
    doc["frames"].append(frame)
    doc["current_frame"] = frame_id
    _t(doc)
    return frame


def render_canvas(doc: Dict[str, Any], frame_id: Optional[int] = None,
                  layers: Optional[List[int]] = None) -> List[List[Tuple[int, int, int, int]]]:
    """Composite the document into a width x height RGBA grid.

    Respects layer visibility and opacity; returns list of rows, each a
    list of (r,g,b,a) tuples.
    """
    w, h = doc["width"], doc["height"]
    grid: List[List[Tuple[int, int, int, int]]] = [
        [(0, 0, 0, 0)] * w for _ in range(h)
    ]
    frame = get_frame(doc, frame_id)
    wanted = layers if layers is not None else [l["id"] for l in doc["layers"]]
    for layer in doc["layers"]:
        if layer["id"] not in wanted or not layer["visible"]:
            continue
        if is_reference_layer(doc, layer):
            continue
        cel = frame["cels"].get(str(layer["id"]), {})
        op = layer["opacity"] / 255.0
        for key, color in cel.items():
            x_str, y_str = key.split(",")
            x, y = int(x_str), int(y_str)
            if not (0 <= x < w and 0 <= y < h):
                continue
            r, g, b, a = hex_to_rgba(color)
            a = int(a * op)
            br, bg, bb, ba = grid[y][x]
            # straight alpha over
            if a == 255:
                grid[y][x] = (r, g, b, 255)
            elif a == 0:
                continue
            else:
                out_a = a + ba * (255 - a) // 255
                if out_a == 0:
                    grid[y][x] = (0, 0, 0, 0)
                else:
                    nr = (r * a + br * ba * (255 - a) // 255) // out_a
                    ng = (g * a + bg * ba * (255 - a) // 255) // out_a
                    nb = (b * a + bb * ba * (255 - a) // 255) // out_a
                    grid[y][x] = (nr, ng, nb, out_a)
    return grid


# ---------------------------------------------------------------------------
# Frame tags (Aseprite animation tags) + reference layers
# ---------------------------------------------------------------------------

def add_tag(doc, name: str, from_frame: int, to_frame: int,
            color: str = "#42bce8") -> dict:
    """Add a frame tag (named animation range), Aseprite Frame Tags."""
    if from_frame < 0 or to_frame >= len(doc["frames"]) or from_frame > to_frame:
        raise ValueError(f"tag range {from_frame}..{to_frame} invalid "
                         f"(frames: {len(doc['frames'])})")
    if any(t["name"] == name for t in doc.get("frame_tags", [])):
        raise ValueError(f"tag already exists: {name}")
    doc.setdefault("frame_tags", []).append({
        "name": str(name),
        "from": int(from_frame),
        "to": int(to_frame),
        "color": normalize_color(color),
    })
    _t(doc)
    return {"name": str(name), "from": int(from_frame), "to": int(to_frame),
            "tags": len(doc["frame_tags"])}


def list_tags(doc) -> dict:
    return {"tags": list(doc.get("frame_tags", [])),
            "count": len(doc.get("frame_tags", []))}


def remove_tag(doc, name: str) -> dict:
    tags = doc.get("frame_tags", [])
    before = len(tags)
    doc["frame_tags"] = [t for t in tags if t["name"] != str(name)]
    if len(doc["frame_tags"]) == before:
        raise ValueError(f"no such tag: {name}")
    _t(doc)
    return {"removed": str(name), "tags": len(doc["frame_tags"])}


def set_layer_reference(doc, layer_id: int, reference: bool) -> dict:
    """Mark a layer as reference (rotoscoping aid); it is excluded from
    rendering/export (Aseprite Reference Layers)."""
    for layer in doc["layers"]:
        if layer["id"] == int(layer_id):
            old = bool(layer.get("reference", False))
            layer["reference"] = bool(reference)
            _t(doc)
            return {"layer": int(layer_id), "reference": bool(reference),
                    "old": old}
    raise ValueError(f"no such layer: {layer_id}")


def is_reference_layer(doc, layer) -> bool:
    return bool(layer.get("reference", False))
