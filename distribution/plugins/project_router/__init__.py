"""Minimal Foursday project registry and conversation router."""

from .registry import Project, ProjectRegistry, RouteResult


def register(_ctx) -> None:
    """Library plugin; the DWS platform adapter consumes the router directly."""


__all__ = ["Project", "ProjectRegistry", "RouteResult", "register"]
