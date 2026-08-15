"""Aseprite CLI - Real-time terminal rendering.

Renders the pixel-art canvas as an ANSI/VT100 frame that humans watch
in a real terminal while the AI draws. Uses truecolor half-blocks
(U+2580 upper half) so each character cell shows two canvas rows.

`render_terminal(doc, width, height)` returns a frame string that
includes the canvas plus a status line (name, size, frame/layers,
palette swatches, cursor hint). Frames are designed to be idempotent
(no trailing cursor movement) so a UI can simply overwrite the last
frame — like `clear` + print in a REPL.
"""

from typing import Any, Dict, List, Optional, Tuple

from ..core.model import hex_to_rgba, render_canvas

# Checkerboard colors for transparency (dark, terminal-theme friendly)
CHECK_A = (30, 34, 42)
CHECK_B = (22, 26, 34)


def _ansi_fg(rgb: Tuple[int, int, int]) -> str:
    return f"\x1b[38;2;{rgb[0]};{rgb[1]};{rgb[2]}m"


def _ansi_bg(rgb: Tuple[int, int, int]) -> str:
    return f"\x1b[48;2;{rgb[0]};{rgb[1]};{rgb[2]}m"


def _checker(x: int, y: int) -> Tuple[int, int, int]:
    return CHECK_A if (x + y) % 2 == 0 else CHECK_B


def render_terminal(doc: Dict[str, Any], scale: int = 1,
                    frame_id: Optional[int] = None, color: bool = True,
                    with_status: bool = True, onion: int = 0) -> str:
    """Render the current frame as an ANSI frame. scale = canvas pixels per cell.

    onion: >0 overlays the N previous/next frames at 35% alpha (onion
    skinning, Aseprite parity) so animators see motion ghosts.
    """
    grid = render_canvas(doc, frame_id)
    if onion and len(doc["frames"]) > 1 and frame_id is None:
        frame_id = doc["current_frame"]
        ghost = {}
        for f in doc["frames"]:
            if abs(f["id"] - frame_id) <= onion and f["id"] != frame_id:
                g = render_canvas(doc, f["id"])
                for y in range(doc["height"]):
                    for x in range(doc["width"]):
                        r, g2, b, a = g[y][x]
                        if a:
                            ghost[(x, y)] = (r, g2, b, int(a * 0.35))
        if ghost:
            for y in range(doc["height"]):
                for x in range(doc["width"]):
                    if x not in [p[0] for p in ghost]:
                        continue
                    key = (x, y)
                    if key in ghost and grid[y][x][3] == 0:
                        grid[y][x] = ghost[key]
    w, h = doc["width"], doc["height"]
    scale = max(1, int(scale))
    if not color:
        lines = []
        for y in range(0, h, max(1, scale * 2)):
            row = []
            for x in range(0, w, scale):
                r, g, b, a = grid[y][x]
                row.append(" " if a == 0 else "##")
            lines.append("".join(row))
        body = "\n".join(lines)
    else:
        lines = []
        for y in range(0, h, 2):
            row_chars: List[str] = []
            for x in range(0, w, scale):
                top = grid[y][x]
                bottom = grid[y + 1][x] if y + 1 < h else (0, 0, 0, 0)
                ta = top[3]
                ba = bottom[3]
                if ta == 0 and ba == 0:
                    cb = _checker(x, y // scale)
                    row_chars.append(_ansi_bg(cb) + " ")
                    continue
                if ta == 0 and ba > 0:
                    cb = _checker(x, y // scale)
                    row_chars.append(_ansi_fg(cb) + _ansi_bg(bottom[:3]) + "▄")
                    continue
                if ta > 0 and ba == 0:
                    cb = _checker(x, y // scale)
                    row_chars.append(_ansi_fg(top[:3]) + _ansi_bg(cb) + "▀")
                    continue
                row_chars.append(_ansi_fg(top[:3]) + _ansi_bg(bottom[:3]) + "▀")
            lines.append("".join(row_chars) + "\x1b[0m")
        body = "\n".join(lines)

    out = body
    if with_status:
        px = sum(len(cel) for f in doc["frames"] for cel in f["cels"].values())
        title = f"{doc['name']}  {w}x{h}  frame {doc['current_frame'] + 1}/{len(doc['frames'])}"
        if doc["frames"]:
            title += f"  layer {doc['current_layer'] + 1}/{len(doc['layers'])}"
        title += f"  px:{px}"
        sw = " ".join(
            f"{_ansi_bg(hex_to_rgba(c['color'])[:3])} \x1b[0m"
            for c in doc["palette"][:16]
        )
        out += "\n" + title
        if sw:
            out += "\n" + sw
    return out


def render_preview_png(doc: Dict[str, Any], path: str, scale: int = 8,
                       frame_id: Optional[int] = None) -> str:
    """Render a preview PNG (nearest-neighbor, checkerboard bg)."""
    from PIL import Image
    grid = render_canvas(doc, frame_id)
    w, h = doc["width"], doc["height"]
    img = Image.new("RGB", (w * scale, h * scale), CHECK_B)
    px = img.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = grid[y][x]
            for sy in range(scale):
                for sx in range(scale):
                    if a == 0:
                        cb = _checker(x, y)
                        px[x * scale + sx, y * scale + sy] = cb
                    else:
                        px[x * scale + sx, y * scale + sy] = (r, g, b)
    img.save(path, "PNG")
    return path
