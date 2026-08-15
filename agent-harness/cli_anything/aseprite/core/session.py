"""Aseprite CLI - Session, undo/redo and history.

Undo/redo uses snapshot stacks (like Aseprite's command pattern, but
document-level). Every mutating command pushes a pre-state snapshot.
"""

import json
import os
from typing import Any, Dict, List, Optional

from .model import restore, snapshot

MAX_HISTORY = 100


class Session:
    """Holds one active document plus undo/redo stacks and history log."""

    def __init__(self) -> None:
        self.doc: Optional[Dict[str, Any]] = None
        self.path: Optional[str] = None
        self.undo_stack: List[str] = []
        self.redo_stack: List[str] = []
        self.history: List[Dict[str, Any]] = []
        self._dirty = False

    @property
    def dirty(self) -> bool:
        return self._dirty

    def set_document(self, doc: Dict[str, Any], path: Optional[str] = None,
                     record: bool = True) -> None:
        self.doc = doc
        self.path = path
        self.undo_stack = []
        self.redo_stack = []
        self._dirty = False
        if record:
            self.history.append({"op": "new/open", "detail": path or doc.get("name"),
                                 "undo_size": 0, "pixels": 0})

    def push_undo(self) -> None:
        if self.doc is None:
            return
        self.undo_stack.append(snapshot(self.doc))
        if len(self.undo_stack) > MAX_HISTORY:
            self.undo_stack.pop(0)
        self.redo_stack = []
        self._dirty = True

    def undo(self) -> Dict[str, Any]:
        if self.doc is None or not self.undo_stack:
            raise ValueError("nothing to undo")
        self.redo_stack.append(snapshot(self.doc))
        restore(self.doc, self.undo_stack.pop())
        self._dirty = True
        return {"undone": True, "undo_depth": len(self.undo_stack),
                "redo_depth": len(self.redo_stack)}

    def redo(self) -> Dict[str, Any]:
        if self.doc is None or not self.redo_stack:
            raise ValueError("nothing to redo")
        self.undo_stack.append(snapshot(self.doc))
        restore(self.doc, self.redo_stack.pop())
        self._dirty = True
        return {"redone": True, "undo_depth": len(self.undo_stack),
                "redo_depth": len(self.redo_stack)}

    def status(self) -> Dict[str, Any]:
        if self.doc is None:
            return {"open": False}
        px = 0
        for frame in self.doc["frames"]:
            for cel in frame["cels"].values():
                px += len(cel)
        return {
            "open": True,
            "name": self.doc["name"],
            "path": self.path,
            "size": f"{self.doc['width']}x{self.doc['height']}",
            "frames": len(self.doc["frames"]),
            "layers": len(self.doc["layers"]),
            "palette": len(self.doc["palette"]),
            "pixels": px,
            "undo": len(self.undo_stack),
            "redo": len(self.redo_stack),
            "dirty": self._dirty,
            "history": list(self.history[-10:]),
        }

    def log(self, op: str, detail: str, pixels: int = 0) -> None:
        entry = {"op": op, "detail": detail, "undo_size": len(self.undo_stack),
                 "pixels": pixels}
        self.history.append(entry)
        self.history = self.history[-200:]

    def history_json(self) -> Dict[str, Any]:
        return {"history": list(self.history)}

    # -- persistence (undo/redo stacks survive separate CLI processes) -------

    def save_state(self, path: str) -> None:
        """Persist undo/redo stacks next to the project file."""
        side = path + ".history.json"
        payload = {"undo": list(self.undo_stack[-MAX_HISTORY:]),
                   "redo": list(self.redo_stack)}
        with open(side, "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def load_state(self, path: str) -> None:
        """Restore undo/redo stacks from the sidecar file if present."""
        side = path + ".history.json"
        if not os.path.isfile(side):
            return
        try:
            with open(side, "r", encoding="utf-8") as f:
                payload = json.load(f)
            self.undo_stack = list(payload.get("undo", []))[-MAX_HISTORY:]
            self.redo_stack = list(payload.get("redo", []))
        except Exception:
            self.undo_stack = []
            self.redo_stack = []

    def clear_state(self, path: str) -> None:
        side = path + ".history.json"
        if os.path.isfile(side):
            try:
                os.remove(side)
            except OSError:
                pass
