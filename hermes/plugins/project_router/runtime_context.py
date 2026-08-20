"""Per-turn routed project context carried through Hermes background tasks."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

from .registry import Project, RouteResult


_CURRENT_PROJECT: ContextVar[Optional[Project]] = ContextVar(
    "foursday_current_project",
    default=None,
)
_CURRENT_PRINCIPAL_ID: ContextVar[Optional[str]] = ContextVar(
    "foursday_current_principal_id",
    default=None,
)


@contextmanager
def routed_project_scope(
    route: RouteResult,
    *,
    principal_id: Optional[str] = None,
) -> Iterator[None]:
    project_token = _CURRENT_PROJECT.set(getattr(route, "project", None))
    principal_token = _CURRENT_PRINCIPAL_ID.set(
        str(principal_id).strip() if principal_id else None
    )
    try:
        yield
    finally:
        _CURRENT_PRINCIPAL_ID.reset(principal_token)
        _CURRENT_PROJECT.reset(project_token)


def current_routed_project() -> Optional[Project]:
    return _CURRENT_PROJECT.get()


def current_routed_principal_id() -> Optional[str]:
    return _CURRENT_PRINCIPAL_ID.get()


__all__ = [
    "current_routed_principal_id",
    "current_routed_project",
    "routed_project_scope",
]
