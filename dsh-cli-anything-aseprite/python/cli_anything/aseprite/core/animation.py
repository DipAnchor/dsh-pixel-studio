"""Aseprite CLI - Animation (frames) management."""

from typing import Any, Dict, Optional

from .model import _t, add_frame as _add_frame, get_frame, get_cel


def list_frames(doc) -> dict:
    return {
        "frames": [
            {"id": f["id"], "duration": f["duration"], "cels": len(f["cels"])}
            for f in doc["frames"]
        ],
        "current": doc["current_frame"],
        "fps": int(1000 / doc["frames"][0]["duration"]) if doc["frames"] else 0,
    }


def add_frame(doc, duration: int = 100, copy: bool = True) -> dict:
    if not copy:
        # blank frame: clear cels after creation
        frame = _add_frame(doc, duration)
        for key in list(frame["cels"].keys()):
            frame["cels"][key] = {}
    else:
        frame = _add_frame(doc, duration)
    _t(doc)
    return {"id": frame["id"], "duration": duration, "total": len(doc["frames"])}


def set_frame(doc, frame_id: int) -> dict:
    f = get_frame(doc, int(frame_id))
    doc["current_frame"] = f["id"]
    _t(doc)
    return {"current_frame": f["id"], "total": len(doc["frames"])}


def remove_frame(doc, frame_id: Optional[int] = None) -> dict:
    frame_id = doc["current_frame"] if frame_id is None else int(frame_id)
    if len(doc["frames"]) <= 1:
        raise ValueError("cannot remove the last frame")
    target = get_frame(doc, frame_id)
    doc["frames"] = [f for f in doc["frames"] if f["id"] != frame_id]
    if doc["current_frame"] == frame_id:
        doc["current_frame"] = doc["frames"][min(len(doc["frames"]) - 1, frame_id)]["id"] if frame_id < len(doc["frames"]) else doc["frames"][-1]["id"]
    _t(doc)
    return {"removed": target["id"], "total": len(doc["frames"])}


def set_duration(doc, frame_id: int, duration: int) -> dict:
    duration = max(1, int(duration))
    f = get_frame(doc, int(frame_id))
    old = f["duration"]
    f["duration"] = duration
    _t(doc)
    return {"frame": f["id"], "old_duration": old, "new_duration": duration}


def duplicate_frame(doc, frame_id: Optional[int] = None) -> dict:
    frame_id = doc["current_frame"] if frame_id is None else int(frame_id)
    import copy
    src = get_frame(doc, frame_id)
    new = copy.deepcopy(src)
    new["id"] = max(f["id"] for f in doc["frames"]) + 1
    doc["frames"].append(new)
    doc["current_frame"] = new["id"]
    _t(doc)
    return {"id": new["id"], "copied_from": frame_id, "total": len(doc["frames"])}
