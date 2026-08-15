"""Aseprite CLI - Layer management."""

from typing import Any, Dict, Optional

from .model import _t, add_layer as _add_layer, get_frame


def list_layers(doc) -> dict:
    return {"layers": [dict(l) for l in doc["layers"]], "current": doc["current_layer"]}


def add_layer(doc, name: str = "layer") -> dict:
    layer = _add_layer(doc, name)
    return {"id": layer["id"], "name": layer["name"], "stack": [l["name"] for l in doc["layers"]]}


def remove_layer(doc, layer_id: Optional[int] = None) -> dict:
    layer_id = doc["current_layer"] if layer_id is None else int(layer_id)
    if len(doc["layers"]) <= 1:
        raise ValueError("cannot remove the last layer")
    target = None
    for l in doc["layers"]:
        if l["id"] == layer_id:
            target = l
            break
    if target is None:
        raise ValueError(f"no such layer: {layer_id}")
    doc["layers"] = [l for l in doc["layers"] if l["id"] != layer_id]
    for frame in doc["frames"]:
        frame["cels"].pop(str(layer_id), None)
    if doc["current_layer"] == layer_id:
        doc["current_layer"] = doc["layers"][-1]["id"]
    _t(doc)
    return {"removed": target["name"], "stack": [l["name"] for l in doc["layers"]]}


def set_layer(doc, layer_id: int) -> dict:
    layer_id = int(layer_id)
    for l in doc["layers"]:
        if l["id"] == layer_id:
            doc["current_layer"] = layer_id
            _t(doc)
            return {"current_layer": layer_id, "name": l["name"]}
    raise ValueError(f"no such layer: {layer_id}")


def set_layer_property(doc, layer_id: int, prop: str, value: Any) -> dict:
    layer_id = int(layer_id)
    if prop not in ("name", "visible", "opacity", "reference"):
        raise ValueError(f"unsupported layer property: {prop}")
    for l in doc["layers"]:
        if l["id"] == layer_id:
            if prop == "visible":
                v = str(value).lower() in ("1", "true", "yes", "on")
            elif prop == "opacity":
                v = max(0, min(255, int(value)))
            elif prop == "reference":
                v = str(value).lower() in ("1", "true", "yes", "on")
            else:
                v = str(value)
            old = l.get(prop)
            l[prop] = v
            _t(doc)
            return {"layer": layer_id, "prop": prop, "old": old, "new": v}
    raise ValueError(f"no such layer: {layer_id}")


def duplicate_layer(doc, layer_id: Optional[int] = None, name: Optional[str] = None) -> dict:
    layer_id = doc["current_layer"] if layer_id is None else int(layer_id)
    src = None
    for l in doc["layers"]:
        if l["id"] == layer_id:
            src = l
            break
    if src is None:
        raise ValueError(f"no such layer: {layer_id}")
    import copy
    new_layer = copy.deepcopy(src)
    new_layer["id"] = max(l["id"] for l in doc["layers"]) + 1
    new_layer["name"] = name or f"{src['name']}-copy"
    doc["layers"].append(new_layer)
    for frame in doc["frames"]:
        key = str(layer_id)
        if key in frame["cels"]:
            frame["cels"][str(new_layer["id"])] = dict(frame["cels"][key])
    doc["current_layer"] = new_layer["id"]
    _t(doc)
    return {"id": new_layer["id"], "name": new_layer["name"],
            "stack": [l["name"] for l in doc["layers"]]}


def merge_visible(doc) -> dict:
    """Merge all visible layers into the bottom-most visible one."""
    from .model import render_canvas, rgba_to_hex
    visible = [l for l in doc["layers"] if l["visible"]]
    if len(visible) < 2:
        raise ValueError("need at least 2 visible layers to merge")
    base = visible[0]
    grid = render_canvas(doc)
    base_cels = {f["id"]: f["cels"] for f in doc["frames"]}
    for frame in doc["frames"]:
        cel = frame["cels"].setdefault(str(base["id"]), {})
        cel.clear()
        for yy in range(doc["height"]):
            for xx in range(doc["width"]):
                r, g, b, a = grid[yy][xx]
                if a:
                    cel[f"{xx},{yy}"] = rgba_to_hex(r, g, b, a)
        for l in visible[1:]:
            frame["cels"].pop(str(l["id"]), None)
    doc["layers"] = [l for l in doc["layers"] if l in visible[:1] or not l["visible"]]
    doc["current_layer"] = base["id"]
    _t(doc)
    return {"merged": [l["name"] for l in visible], "remaining": [l["name"] for l in doc["layers"]]}
