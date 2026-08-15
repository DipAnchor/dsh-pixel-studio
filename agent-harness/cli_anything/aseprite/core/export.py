"""Aseprite CLI - Export pipeline.

Exports a document to PNG (still), GIF (animation), sprite-sheet PNG+JSON,
and native .aseprite binary files (writer implemented from the public
ASE file format spec). If a real `aseprite` binary is available, it is
used for advanced conversion (see utils/aseprite_backend.py).
"""

import io
import json
import os
import struct
import zlib
from typing import Any, Dict, List, Optional

from .model import get_frame, hex_to_rgba, render_canvas

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

try:
    from ..utils.aseprite_backend import find_aseprite, run_batch
    HAS_BACKEND = True
except Exception:
    HAS_BACKEND = False


def _grid_to_pil(doc, frame_id=None):
    if not HAS_PIL:
        raise RuntimeError("Pillow is required for raster export (pip install pillow)")
    grid = render_canvas(doc, frame_id)
    w, h = doc["width"], doc["height"]
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = grid[y][x]
    return img


def export_png(doc, path: str, scale: int = 1, frame_id=None) -> dict:
    scale = max(1, int(scale))
    img = _grid_to_pil(doc, frame_id)
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    img.save(path, "PNG")
    return {"path": os.path.abspath(path), "width": img.width, "height": img.height,
            "scale": scale, "format": "png"}


def export_gif(doc, path: str, scale: int = 1, loop: int = 0) -> dict:
    if not HAS_PIL:
        raise RuntimeError("Pillow is required for GIF export (pip install pillow)")
    scale = max(1, int(scale))
    frames = []
    durations = []
    for frame in doc["frames"]:
        img = _grid_to_pil(doc, frame["id"])
        if scale > 1:
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        frames.append(img.convert("RGBA"))
        durations.append(max(10, frame["duration"]))
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    frames[0].save(path, save_all=True, append_images=frames[1:],
                   duration=durations, loop=loop, disposal=2)
    return {"path": os.path.abspath(path), "frames": len(frames),
            "scale": scale, "format": "gif"}


def export_spritesheet(doc, path: str, data_path: Optional[str] = None,
                       direction: str = "horizontal", scale: int = 1) -> dict:
    """Export all frames into one sprite sheet + JSON metadata (aseprite-style)."""
    scale = max(1, int(scale))
    frames = doc["frames"]
    fw, fh = doc["width"] * scale, doc["height"] * scale
    if direction == "horizontal":
        sheet = Image.new("RGBA", (fw * len(frames), fh), (0, 0, 0, 0))
    elif direction == "vertical":
        sheet = Image.new("RGBA", (fw, fh * len(frames)), (0, 0, 0, 0))
    else:
        raise ValueError("direction must be horizontal or vertical")
    meta = {"frames": {}, "meta": {
        "app": "cli-anything-aseprite", "version": "1.0.0",
        "image": os.path.basename(path),
        "size": {"w": sheet.width, "h": sheet.height}, "scale": str(scale),
        "frameTags": [{"name": "all", "from": 0, "to": len(frames) - 1}],
    }}
    for i, frame in enumerate(frames):
        img = _grid_to_pil(doc, frame["id"])
        if scale > 1:
            img = img.resize((fw, fh), Image.NEAREST)
        if direction == "horizontal":
            x, y = i * fw, 0
        else:
            x, y = 0, i * fh
        sheet.paste(img, (x, y), img)
        meta["frames"][f"frame{i}"] = {
            "frame": {"x": x, "y": y, "w": fw, "h": fh},
            "duration": frame["duration"],
        }
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    sheet.save(path, "PNG")
    if data_path:
        with open(data_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)
    return {"path": os.path.abspath(path), "data_path": os.path.abspath(data_path) if data_path else None,
            "frames": len(frames), "sheet_w": sheet.width, "sheet_h": sheet.height}


# ---------------------------------------------------------------------------
# .aseprite binary writer (ASE file format spec)
# ---------------------------------------------------------------------------

def _pack_string(s: str) -> bytes:
    b = s.encode("utf-8")
    return struct.pack("<H", len(b)) + b


def _pack_palette_chunk(doc) -> bytes:
    pal = doc["palette"]
    body = struct.pack("<I", 8)               # palette size (v1 header)
    body += struct.pack("<II", 0, max(0, len(pal) - 1))  # first, last index
    body += b"\x00" * 8
    for c in pal:
        flags = 1 if c.get("name") else 0
        r, g, b, a = hex_to_rgba(c["color"])
        body += struct.pack("<HBBBB", flags, r, g, b, a)
        if flags:
            body += _pack_string(c["name"])
    return body


def _pack_layer_chunk(doc) -> bytes:
    body = b""
    for i, layer in enumerate(doc["layers"]):
        flags = 0
        if layer.get("visible", True):
            flags |= 1
        if i == 0:
            flags |= 8  # background
        body += struct.pack("<HHHHBB", flags, 0, 0, 0, layer.get("opacity", 255), 0)
        body += b"\x00" * 3
        body += _pack_string(layer["name"])
    return body


def _pack_cel_chunk(doc, frame_id: int, layer: dict) -> bytes:
    frame = get_frame(doc, frame_id)
    cel = frame["cels"].get(str(layer["id"]), {})
    w, h = doc["width"], doc["height"]
    # raw image data: rows of B,G,R,A
    raw = bytearray()
    for y in range(h):
        for x in range(w):
            color = cel.get(f"{x},{y}")
            if color:
                r, g, b, a = hex_to_rgba(color)
            else:
                r = g = b = a = 0
            raw += struct.pack("<BBBB", b, g, r, a)
    compressed = zlib.compress(bytes(raw), 9)
    if len(compressed) < len(raw):
        body = struct.pack("<HHHBH", doc["layers"].index(layer), 0, 0, 0, 2)
        body += b"\x00" * 7
        body += struct.pack("<HH", w, h)
        body += struct.pack("<I", len(compressed))
        body += compressed
    else:
        body = struct.pack("<HHHBH", doc["layers"].index(layer), 0, 0, 0, 0)
        body += b"\x00" * 7
        body += struct.pack("<HH", w, h)
        body += bytes(raw)
    return body


def _pack_frame_tags_chunk(doc) -> bytes:
    if len(doc["frames"]) < 2:
        return None
    body = struct.pack("<H", 1)
    body += b"\x00" * 8
    body += struct.pack("<HH", 0, len(doc["frames"]) - 1)
    body += struct.pack("<B", 0)              # loop direction forward
    body += b"\x00" * 8
    body += b"\x00" * 6
    body += b"\x00" * 7
    body += struct.pack("<BBB", 0x42, 0x9c, 0xe8)
    body += b"\x00"
    body += _pack_string("all")
    return body


def export_aseprite(doc, path: str) -> dict:
    """Write the document as a native .aseprite file (ASE spec)."""
    w, h = doc["width"], doc["height"]
    frames = doc["frames"]
    color_depth = 32  # RGBA
    header = struct.pack("<I", 0xA5E0)
    header += struct.pack("<I", len(frames))
    header += struct.pack("<HH", w, h)
    header += struct.pack("<H", color_depth)
    header += struct.pack("<I", 1)  # flags: layered
    header += struct.pack("<H", 100)  # speed (deprecated)
    header += struct.pack("<I", 0)
    header += struct.pack("<I", 0)
    header += struct.pack("<BB", 0, 0)
    header += struct.pack("<I", 0x461)  # sRGB color profile
    header += b"\x00" * 4               # color profile data length + reserved
    header += b"\x00" * 16
    header += b"\x00" * 2
    header += b"\x00" * 72

    layer_chunk = _pack_layer_chunk(doc)
    palette_chunk = _pack_palette_chunk(doc)
    tags_chunk = _pack_frame_tags_chunk(doc)

    frames_bytes = b""
    for frame in frames:
        chunks = b""
        chunks += struct.pack("<I", len(layer_chunk)) + struct.pack("<H", 0x2004) + layer_chunk
        chunks += struct.pack("<I", len(palette_chunk)) + struct.pack("<H", 0x2019) + palette_chunk
        if tags_chunk:
            chunks += struct.pack("<I", len(tags_chunk)) + struct.pack("<H", 0x2018) + tags_chunk
        for layer in doc["layers"]:
            cel_chunk = _pack_cel_chunk(doc, frame["id"], layer)
            chunks += struct.pack("<I", len(cel_chunk)) + struct.pack("<H", 0x2005) + cel_chunk
        frame_bytes = struct.pack("<H", frame["duration"]) + b"\x00" * 6
        frames_bytes += struct.pack("<I", len(frame_bytes) + len(chunks)) + frame_bytes + chunks

    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with open(path, "wb") as f:
        f.write(header + frames_bytes)
    size = os.path.getsize(path)
    return {"path": os.path.abspath(path), "format": "aseprite",
            "frames": len(frames), "layers": len(doc["layers"]),
            "bytes": size}


def export(doc, path: str, scale: int = 1, spritesheet: bool = False,
           direction: str = "horizontal", data_path: Optional[str] = None) -> dict:
    """Dispatch export by file extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".png" and spritesheet:
        return export_spritesheet(doc, path, data_path, direction, scale)
    if ext == ".png":
        return export_png(doc, path, scale)
    if ext == ".gif":
        return export_gif(doc, path, scale)
    if ext == ".aseprite":
        return export_aseprite(doc, path)
    if ext == ".ase":
        return export_aseprite(doc, path)
    raise ValueError(f"unsupported export format: {ext} (png/gif/aseprite)")


def supported_formats() -> dict:
    return {"formats": ["png", "gif", "aseprite"], "requires_pillow": not HAS_PIL}


def export_png_sequence(doc, directory: str, scale: int = 1,
                        filename: str = "frame") -> dict:
    """Export every frame as its own PNG (Aseprite File > Export > PNG file)."""
    scale = max(1, int(scale))
    os.makedirs(directory, exist_ok=True)
    paths = []
    for frame in doc["frames"]:
        p = os.path.join(directory, f"{filename}{frame['id']:03d}.png")
        export_png(doc, p, scale, frame_id=frame["id"]) if False else None
        img = _grid_to_pil(doc, frame["id"])
        if scale > 1:
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        img.save(p, "PNG")
        paths.append(os.path.abspath(p))
    return {"directory": os.path.abspath(directory), "frames": len(paths),
            "files": paths, "scale": scale, "format": "png-sequence"}
