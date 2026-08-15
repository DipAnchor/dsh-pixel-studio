"""Aseprite CLI - Drawing primitives (canvas operations).

Implements the human drawing vocabulary on the sparse cel model:
pixel, line, rectangle, ellipse, flood fill, eraser, copy/paste,
and transforms. Every operation is a single logical action so an
agent can draw "like a human" one stroke at a time.
"""

import math
from typing import Any, Dict, List, Optional, Tuple

from .model import (
    check_bounds, get_cel, hex_to_rgba, normalize_color, pixel_at,
    render_canvas, rgba_to_hex, set_pixel, _t,
)


def _stroke_points(x0: int, y0: int, x1: int, y1: int) -> List[Tuple[int, int]]:
    """Bresenham line points, inclusive of both ends."""
    pts = []
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    x, y = x0, y0
    while True:
        pts.append((x, y))
        if x == x1 and y == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x += sx
        if e2 <= dx:
            err += dx
            y += sy
    return pts


def draw_pixel(doc, x, y, color, layer_id=None) -> dict:
    pts = _target_points(doc, [(int(x), int(y))])
    n = _paint(doc, pts, color, layer_id)
    return {"x": int(x), "y": int(y), "color": color,
            "changed": n > 0, "pixels": n}


def draw_line(doc, x0, y0, x1, y1, color, layer_id=None) -> dict:
    pts = _stroke_points(int(x0), int(y0), int(x1), int(y1))
    n = _paint(doc, pts, color, layer_id)
    return {"x0": int(x0), "y0": int(y0), "x1": int(x1), "y1": int(y1),
            "color": color, "points": len(pts), "painted": n}


def _rect_points(x, y, w, h, fill: bool) -> List[Tuple[int, int]]:
    pts = []
    x0, y0, x1, y1 = x, y, x + w - 1, y + h - 1
    if fill:
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                pts.append((xx, yy))
    else:
        for xx in range(x0, x1 + 1):
            pts.append((xx, y0))
            pts.append((xx, y1))
        for yy in range(y0 + 1, y1):
            pts.append((x0, yy))
            pts.append((x1, yy))
    return pts


def draw_rect(doc, x, y, w, h, color, fill=False, layer_id=None) -> dict:
    w, h = int(w), int(h)
    if w <= 0 or h <= 0:
        raise ValueError("rect width/height must be positive")
    pts = _rect_points(int(x), int(y), w, h, fill)
    n = _paint(doc, pts, color, layer_id)
    return {"x": int(x), "y": int(y), "w": w, "h": h, "fill": fill,
            "color": color, "painted": n}


def _ellipse_points(cx: float, cy: float, rx: float, ry: float, fill: bool) -> List[Tuple[int, int]]:
    """Midpoint ellipse algorithm, optionally filled."""
    pts = set()
    if rx <= 0 or ry <= 0:
        return []
    rx, ry = float(rx), float(ry)
    x, y = 0, int(ry)
    rx2, ry2 = rx * rx, ry * ry
    # region 1
    px, py = 0.0, float(ry)
    d1 = ry2 - rx2 * ry + 0.25 * rx2
    while rx2 * (py - 0.5) > ry2 * (px + 1):
        for (sx, sy) in [(px, py), (-px, py), (px, -py), (-px, -py)]:
            pts.add((int(round(cx + sx)), int(round(cy + sy))))
        px += 1
        if d1 < 0:
            d1 += ry2 * (2 * px + 1)
        else:
            py -= 1
            d1 += ry2 * (2 * px + 1) - 2 * rx2 * (py - 1)
    # region 2
    d2 = ry2 * (px + 0.5) ** 2 + rx2 * (py - 1) ** 2 - rx2 * ry2
    while py > 0:
        for (sx, sy) in [(px, py), (-px, py), (px, -py), (-px, -py)]:
            pts.add((int(round(cx + sx)), int(round(cy + sy))))
        py -= 1
        if d2 > 0:
            d2 += rx2 * (1 - 2 * py)
        else:
            px += 1
            d2 += ry2 * (2 * px + 2) + rx2 * (1 - 2 * py)
    pts.add((int(round(cx)), int(round(cy))))
    if fill:
        out = set()
        by_x: Dict[int, List[int]] = {}
        for (px, py) in pts:
            by_x.setdefault(py, []).append(px)
        for py, xs in by_x.items():
            lo, hi = min(xs), max(xs)
            for xx in range(lo, hi + 1):
                out.add((xx, py))
        return list(out)
    return list(pts)


def draw_ellipse(doc, cx, cy, rx, ry, color, fill=False, layer_id=None) -> dict:
    pts = _ellipse_points(float(cx), float(cy), float(rx), float(ry), fill)
    n = _paint(doc, pts, color, layer_id)
    return {"cx": int(cx), "cy": int(cy), "rx": int(rx), "ry": int(ry),
            "fill": fill, "color": color, "painted": n}


def flood_fill(doc, x, y, color, tolerance: int = 0, layer_id=None) -> dict:
    """BFS flood fill from (x,y) replacing connected same-ish colors."""
    x, y = int(x), int(y)
    check_bounds(doc, x, y)
    cel = get_cel(doc, layer_id)
    target = pixel_at(doc, x, y, layer_id)
    color = normalize_color(color)
    if target == color:
        return {"x": x, "y": y, "color": color, "painted": 0, "already": True}
    w, h = doc["width"], doc["height"]

    def similar(a: Optional[str], b: Optional[str]) -> bool:
        if a is None and b is None:
            return True
        if a is None or b is None:
            return False
        if tolerance <= 0:
            return a == b
        ra, ga, ba, aa = hex_to_rgba(a)
        rb, gb, bb, ab = hex_to_rgba(b)
        return (abs(ra - rb) + abs(ga - gb) + abs(ba - bb) + abs(aa - ab)) <= tolerance * 4

    stack = [(x, y)]
    seen = set()
    n = 0
    while stack:
        px, py = stack.pop()
        if (px, py) in seen:
            continue
        seen.add((px, py))
        cur = pixel_at(doc, px, py, layer_id)
        if not similar(cur, target):
            continue
        if set_pixel(doc, px, py, color, layer_id):
            n += 1
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = px + dx, py + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in seen:
                stack.append((nx, ny))
    _t(doc) if n else None
    return {"x": x, "y": y, "color": color, "tolerance": tolerance, "painted": n}


def erase(doc, x, y, radius: int = 0, layer_id=None) -> dict:
    """Erase a pixel or a square of radius r around (x,y)."""
    x, y, radius = int(x), int(y), int(radius)
    n = 0
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            try:
                if set_pixel(doc, x + dx, y + dy, None, layer_id):
                    n += 1
            except ValueError:
                pass
    _t(doc) if n else None
    return {"x": x, "y": y, "radius": radius, "erased": n}


def get_region(doc, x, y, w, h) -> Dict[str, Any]:
    """Read a rectangular region of the current frame (composited)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    grid = render_canvas(doc)
    rows = []
    for yy in range(y, min(y + h, doc["height"])):
        row = []
        for xx in range(x, min(x + w, doc["width"])):
            r, g, b, a = grid[yy][xx]
            row.append(rgba_to_hex(r, g, b, a) if a else None)
        rows.append(row)
    return {"x": x, "y": y, "w": w, "h": h, "rows": rows}


def invert_region(doc, x, y, w, h, layer_id=None) -> dict:
    """Invert colors in a rectangular region (current cel)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    cel = get_cel(doc, layer_id)
    n = 0
    for yy in range(y, min(y + h, doc["height"])):
        for xx in range(x, min(x + w, doc["width"])):
            key = f"{xx},{yy}"
            if key in cel:
                r, g, b, a = hex_to_rgba(cel[key])
                cel[key] = rgba_to_hex(255 - r, 255 - g, 255 - b, a)
                n += 1
    _t(doc) if n else None
    return {"x": x, "y": y, "w": w, "h": h, "inverted": n}


def transform(doc, op: str, layer_id=None) -> dict:
    """Whole-cel transforms: flip-h, flip-v, rotate-90, rotate-180, rotate-270."""
    if op not in ("flip-h", "flip-v", "rotate-90", "rotate-180", "rotate-270"):
        raise ValueError(f"unknown transform: {op}")
    cel = get_cel(doc, layer_id)
    w, h = doc["width"], doc["height"]
    items = {}
    for key, color in cel.items():
        xs, ys = key.split(",")
        items[(int(xs), int(ys))] = color
    new_items = {}
    for (px, py), color in items.items():
        if op == "flip-h":
            nx, ny = w - 1 - px, py
        elif op == "flip-v":
            nx, ny = px, h - 1 - py
        elif op == "rotate-90":
            nx, ny = h - 1 - py, px
        elif op == "rotate-180":
            nx, ny = w - 1 - px, h - 1 - py
        elif op == "rotate-270":
            nx, ny = py, w - 1 - px
        else:
            raise ValueError(f"unknown transform: {op}")
        if 0 <= nx < w and 0 <= ny < h:
            new_items[(nx, ny)] = color
    cel.clear()
    for (px, py), color in new_items.items():
        cel[f"{px},{py}"] = color
    _t(doc)
    return {"op": op, "pixels": len(new_items)}


# ---------------------------------------------------------------------------
# Region (selection) operations — mirrors Aseprite selection semantics:
# CopyRegion (copy/paste a rectangular selection), ClearRect (clear a rect),
# and move-selection-content. A rectangular selection is the CLI equivalent
# of Aseprite's marquee selection; the clipboard is in-memory per process.
# ---------------------------------------------------------------------------

_clipboard = {"w": 0, "h": 0, "rows": [], "color_mode": "rgba"}


def region_fill(doc, x, y, w, h, color, layer_id=None) -> dict:
    """Fill a rectangular selection with a color (like flood-fill in a marquee)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    color = normalize_color(color)
    n = 0
    for yy in range(y, min(y + h, doc["height"])):
        for xx in range(x, min(x + w, doc["width"])):
            if 0 <= xx < doc["width"] and 0 <= yy < doc["height"]:
                if set_pixel(doc, xx, yy, color, layer_id):
                    n += 1
    _t(doc) if n else None
    return {"x": x, "y": y, "w": w, "h": h, "color": color, "painted": n}


def region_clear(doc, x, y, w, h, layer_id=None) -> dict:
    """Clear a rectangular selection to transparency (Aseprite ClearRect)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    cel = get_cel(doc, layer_id)
    n = 0
    for yy in range(y, min(y + h, doc["height"])):
        for xx in range(x, min(x + w, doc["width"])):
            key = f"{xx},{yy}"
            if key in cel:
                del cel[key]
                n += 1
    _t(doc) if n else None
    return {"x": x, "y": y, "w": w, "h": h, "cleared": n}


def region_copy(doc, x, y, w, h, layer_id=None) -> dict:
    """Copy a rectangular selection into the in-memory clipboard (Aseprite Ctrl+C)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    cel = get_cel(doc, layer_id)
    rows = []
    count = 0
    for yy in range(y, min(y + h, doc["height"])):
        row = []
        for xx in range(x, min(x + w, doc["width"])):
            color = cel.get(f"{xx},{yy}")
            row.append(color)
            if color:
                count += 1
        rows.append(row)
    _clipboard["w"] = w
    _clipboard["h"] = h
    _clipboard["rows"] = rows
    _clipboard["color_mode"] = "rgba"
    return {"x": x, "y": y, "w": w, "h": h, "copied": count,
            "clipboard": {"w": w, "h": h}}


def region_paste(doc, x, y, layer_id=None) -> dict:
    """Paste the clipboard at (x,y), overwriting pixels (Aseprite Ctrl+V)."""
    x, y = int(x), int(y)
    if not _clipboard["rows"]:
        raise ValueError("clipboard is empty (use region copy first)")
    w, h = _clipboard["w"], _clipboard["h"]
    cel = get_cel(doc, layer_id)
    n = 0
    for ry, row in enumerate(_clipboard["rows"]):
        for rx, color in enumerate(row):
            px, py = x + rx, y + ry
            if 0 <= px < doc["width"] and 0 <= py < doc["height"]:
                if color is None:
                    cel.pop(f"{px},{py}", None)
                else:
                    cel[f"{px},{py}"] = color
                    n += 1
    _t(doc)
    return {"x": x, "y": y, "w": w, "h": h, "pasted": n}


def region_move(doc, x, y, w, h, dx, dy, layer_id=None) -> dict:
    """Move selection content by (dx,dy): source region is cleared, like
    dragging a marquee selection in Aseprite."""
    x, y, w, h, dx, dy = int(x), int(y), int(w), int(h), int(dx), int(dy)
    cel = get_cel(doc, layer_id)
    items = {}
    for yy in range(y, min(y + h, doc["height"])):
        for xx in range(x, min(x + w, doc["width"])):
            key = f"{xx},{yy}"
            if key in cel:
                items[(xx, yy)] = cel[key]
                del cel[key]
    n = 0
    for (sx, sy), color in items.items():
        tx, ty = sx + dx, sy + dy
        if 0 <= tx < doc["width"] and 0 <= ty < doc["height"]:
            cel[f"{tx},{ty}"] = color
            n += 1
    _t(doc)
    return {"x": x, "y": y, "w": w, "h": h, "dx": dx, "dy": dy, "moved": n}


def save_clipboard(path: str) -> None:
    """Persist the in-memory clipboard next to the project file."""
    import json
    side = path + ".clipboard.json"
    try:
        with open(side, "w", encoding="utf-8") as f:
            json.dump(_clipboard, f)
    except Exception:
        pass


def load_clipboard(path: str) -> None:
    """Restore the clipboard from the sidecar file if present."""
    import json
    import os
    side = path + ".clipboard.json"
    if not os.path.isfile(side):
        return
    try:
        with open(side, "r", encoding="utf-8") as f:
            data = json.load(f)
        _clipboard.update({k: data.get(k) for k in ("w", "h", "rows", "color_mode")})
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Drawing modes (Aseprite parity): symmetry, tiled mode
# ---------------------------------------------------------------------------

_symmetry = None      # None | 'h' | 'v' | 'both'
_tiled = False


def set_symmetry(mode):
    """Enable symmetry drawing: 'h' | 'v' | 'both' | None."""
    global _symmetry
    if mode not in (None, 'h', 'v', 'both'):
        raise ValueError("symmetry must be one of: h, v, both, off")
    _symmetry = mode
    return {"symmetry": _symmetry}


def get_symmetry():
    return _symmetry


def set_tiled(on: bool):
    """Tiled mode: drawing wraps around canvas edges (seamless textures)."""
    global _tiled
    _tiled = bool(on)
    return {"tiled": _tiled}


def get_tiled():
    return _tiled


def _target_points(doc, pts):
    """Apply tiled wrapping + symmetry mirroring to a list of points."""
    w, h = doc["width"], doc["height"]
    out = set()
    for (px, py) in pts:
        if _tiled:
            px = px % w
            py = py % h
        out.add((px, py))
        if _symmetry in ('h', 'both'):
            out.add((w - 1 - px, py))
        if _symmetry in ('v', 'both'):
            out.add((px, h - 1 - py))
        if _symmetry == 'both':
            out.add((w - 1 - px, h - 1 - py))
    return list(out)


def _paint(doc, pts, color, layer_id):
    n = 0
    for (px, py) in _target_points(doc, pts):
        try:
            if set_pixel(doc, px, py, color, layer_id):
                n += 1
        except ValueError:
            pass
    if n:
        _t(doc)
    return n


def gradient(doc, x0, y0, x1, y1, color0, color1,
             direction: str = "line", layer_id=None) -> dict:
    """Gradient tool (Aseprite parity).

    direction=line: interpolate along the segment (x0,y0)->(x1,y1).
    direction=horizontal: interpolate each row across the bounding box.
    direction=vertical: interpolate each column across the bounding box.
    Colors may use rgb16:r,g,b (4096-color interpolation).
    """
    x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
    c0 = hex_to_rgba(normalize_color(color0))
    c1 = hex_to_rgba(normalize_color(color1))

    def lerp(a, b, t):
        return int(a + (b - a) * t)

    def col(t):
        return rgba_to_hex(lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t),
                           lerp(c0[2], c1[2], t), lerp(c0[3], c1[3], t))

    pts = []
    if direction == "line":
        seg = _stroke_points(x0, y0, x1, y1)
        denom = max(1, len(seg) - 1)
        for i, (px, py) in enumerate(seg):
            t = i / denom
            if 0 <= px < doc["width"] and 0 <= py < doc["height"]:
                pts.append((px, py, col(t)))
    elif direction == "horizontal":
        xa, xb = min(x0, x1), max(x0, x1)
        denom = max(1, xb - xa)
        for px in range(max(0, xa), min(xb + 1, doc["width"])):
            t = (px - xa) / denom
            for py in range(max(0, y0), min(y1 + 1, doc["height"])):
                pts.append((px, py, col(t)))
    elif direction == "vertical":
        ya, yb = min(y0, y1), max(y0, y1)
        denom = max(1, yb - ya)
        for py in range(max(0, ya), min(yb + 1, doc["height"])):
            t = (py - ya) / denom
            for px in range(max(0, x0), min(x1 + 1, doc["width"])):
                pts.append((px, py, col(t)))
    else:
        raise ValueError("direction must be line/horizontal/vertical")

    cel = get_cel(doc, layer_id)
    n = 0
    for (px, py, color) in pts:
        key = f"{px},{py}"
        if cel.get(key) != color:
            cel[key] = color
            n += 1
    _t(doc) if n else None
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "direction": direction, "painted": n}


def region_stroke(doc, x, y, w, h, color, layer_id=None) -> dict:
    """Stroke a rectangular selection border (Aseprite Stroke selection)."""
    x, y, w, h = int(x), int(y), int(w), int(h)
    color = normalize_color(color)
    pts = _rect_points(x, y, w, h, fill=False)
    n = _paint(doc, pts, color, layer_id)
    return {"x": x, "y": y, "w": w, "h": h, "color": color, "stroked": n}


def resize_canvas(doc, new_w: int, new_h: int, anchor: str = "c",
                  scale: bool = False) -> dict:
    """Resize the canvas (Aseprite Sprite > Canvas Size).

    anchor: 9-grid position keeping content ('nw','n','ne','w','c',
    'e','sw','s','se'). scale=True rescales content (nearest) instead of
    moving it.
    """
    new_w, new_h = int(new_w), int(new_h)
    if not (1 <= new_w <= 1024 and 1 <= new_h <= 1024):
        raise ValueError("new canvas must be 1..1024")
    if anchor not in ("nw", "n", "ne", "w", "c", "e", "sw", "s", "se"):
        raise ValueError(f"bad anchor: {anchor}")
    old_w, old_h = doc["width"], doc["height"]

    def corner(pos, old_len, new_len):
        if pos in ("nw", "w", "sw"):
            return 0
        if pos in ("ne", "e", "se"):
            return new_len - old_len
        return (new_len - old_len) // 2

    if scale:
        # nearest-neighbor rescale: sample nearest source pixel per target px
        for frame in doc["frames"]:
            for key in list(frame["cels"].keys()):
                cel = frame["cels"][key]
                new_cel = {}
                for ty in range(new_h):
                    sy = min(old_h - 1, int(ty * old_h / new_h))
                    for tx in range(new_w):
                        sx = min(old_w - 1, int(tx * old_w / new_w))
                        color = cel.get(f"{sx},{sy}")
                        if color:
                            new_cel[f"{tx},{ty}"] = color
                frame["cels"][key] = new_cel
    else:
        dx = corner(anchor, old_w, new_w)
        dy = corner(anchor, old_h, new_h)
        for frame in doc["frames"]:
            for key in list(frame["cels"].keys()):
                cel = frame["cels"][key]
                new_cel = {}
                for k, color in cel.items():
                    xs, ys = k.split(",")
                    nx = int(xs) + dx
                    ny = int(ys) + dy
                    if 0 <= nx < new_w and 0 <= ny < new_h:
                        new_cel[f"{nx},{ny}"] = color
                frame["cels"][key] = new_cel

    doc["width"] = new_w
    doc["height"] = new_h
    _t(doc)
    return {"width": new_w, "height": new_h, "anchor": anchor,
            "scale": scale, "old": f"{old_w}x{old_h}"}


def rescale(doc, new_w: int, new_h: int) -> dict:
    """Rescale sprite content to new dimensions (nearest neighbor)."""
    return resize_canvas(doc, new_w, new_h, anchor="nw", scale=True)


def save_modes(path: str) -> None:
    """Persist symmetry/tiled mode next to the project file."""
    import json
    side = path + ".modes.json"
    try:
        with open(side, "w", encoding="utf-8") as f:
            json.dump({"symmetry": _symmetry, "tiled": _tiled}, f)
    except Exception:
        pass


def load_modes(path: str) -> None:
    """Restore symmetry/tiled mode from the sidecar file if present."""
    import json
    import os
    global _symmetry, _tiled
    side = path + ".modes.json"
    if not os.path.isfile(side):
        return
    try:
        with open(side, "r", encoding="utf-8") as f:
            data = json.load(f)
        _symmetry = data.get("symmetry") if data.get("symmetry") in ("h", "v", "both") else None
        _tiled = bool(data.get("tiled", False))
    except Exception:
        pass
