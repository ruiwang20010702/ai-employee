"""Compose Foursday's native Hermes extensions inside one profile boundary."""

from __future__ import annotations

import os
from pathlib import Path
import stat
import sys


_COMPONENTS = (
    "dws_personal",
    "project_router",
    "foursday_boundary",
    "gbrain_memory",
)


def _trusted_plugin_root() -> Path:
    plugin = Path(__file__).resolve(strict=True).parent
    root = plugin.parent
    hermes_home = Path(os.getenv("HERMES_HOME", "")).expanduser().resolve(strict=True)
    expected = hermes_home / "plugins"
    if root != expected or root.is_symlink():
        raise RuntimeError("Foursday component plugins must remain inside the active profile")
    if plugin != root / "foursday_work_twin":
        raise RuntimeError("Foursday composition plugin identity mismatch")
    components = plugin / "components"
    for name in _COMPONENTS:
        directory = components / name
        metadata = directory.lstat()
        manifest = directory / "plugin.yaml"
        manifest_metadata = manifest.lstat()
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or directory.is_symlink()
            or not stat.S_ISREG(manifest_metadata.st_mode)
            or manifest.is_symlink()
        ):
            raise RuntimeError("Foursday component plugin layout is unsafe")
    return components


def register(ctx) -> None:
    root = _trusted_plugin_root()
    components_text = str(root)
    if components_text not in sys.path:
        sys.path.insert(0, components_text)
    from dws_personal import register as register_dws
    from foursday_boundary import register as register_boundary
    from gbrain_memory import register as register_memory

    register_dws(ctx)
    register_boundary(ctx)
    register_memory(ctx)


__all__ = ["register"]
