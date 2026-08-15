"""Aseprite CLI - Backend integration with the real Aseprite binary.

If a real `aseprite` executable is found (built from source or purchased),
we wrap it via its `--batch` mode for advanced conversion (sprite sheet
export with packed layout, palette conversion, dithering, format
conversion). When absent, the harness is fully functional standalone
(the native .aseprite writer in core/export.py is used instead).
"""

import json
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional


def find_aseprite() -> Optional[str]:
    """Locate the aseprite executable or None."""
    env = os.environ.get("ASEPRITE_BIN")
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    return shutil.which("aseprite")


def get_version() -> Dict[str, Any]:
    exe = find_aseprite()
    if not exe:
        return {"available": False, "message": "aseprite binary not found"}
    try:
        out = subprocess.run([exe, "--version"], capture_output=True,
                             text=True, timeout=15)
        return {"available": True, "binary": exe,
                "version": (out.stdout or out.stderr).strip()[:200]}
    except Exception as exc:
        return {"available": False, "message": str(exc)}


def run_batch(args: List[str], timeout: int = 120) -> Dict[str, Any]:
    """Run aseprite in batch mode; raise RuntimeError with install hint if missing."""
    exe = find_aseprite()
    if not exe:
        raise RuntimeError(
            "aseprite binary not found. Build it from https://github.com/aseprite/aseprite "
            "or set ASEPRITE_BIN. The harness still works standalone without it."
        )
    cmd = [exe, "--batch"] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"aseprite batch failed ({proc.returncode}): "
                           f"{(proc.stderr or proc.stdout)[:800]}")
    return {"command": " ".join(cmd), "stdout": proc.stdout[:2000],
            "stderr": proc.stderr[:2000]}
