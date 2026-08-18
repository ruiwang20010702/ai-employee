"""Foursday DWS personal DingTalk platform plugin for Hermes Agent."""

import os

from .adapter import DwsPersonalAdapter, dws_available
from .bridge import JsonLineDwsBridge
from .memory import NodeProjectMemoryProvider


def create_adapter(config):
    from project_router.registry import ProjectRegistry

    registry_path = os.getenv("FOURSDAY_PROJECT_REGISTRY", "").strip()
    fallback = os.getenv("FOURSDAY_FALLBACK_WORKSPACE", "").strip()
    if not registry_path or not fallback:
        return DwsPersonalAdapter(config)
    router = ProjectRegistry.load(
        registry_path,
        fallback_workspace=fallback,
        binding_path=os.getenv("FOURSDAY_ROUTE_STATE_FILE", "").strip() or None,
    )
    memory = None
    if (
        os.getenv("FOURSDAY_MEMORY_CONTEXT_SIDECAR", "").strip()
        and os.getenv("FOURSDAY_PRODUCTION_CONFIG", "").strip()
    ):
        memory = NodeProjectMemoryProvider.from_environment()
    return DwsPersonalAdapter(
        config,
        bridge=JsonLineDwsBridge.from_environment(),
        router=router,
        memory=memory,
    )


def register(ctx) -> None:
    ctx.register_platform(
        name="dws_personal",
        label="DWS Personal DingTalk",
        adapter_factory=create_adapter,
        check_fn=dws_available,
        validate_config=lambda config: bool(config.enabled),
        allowed_users_env="DWS_PERSONAL_ALLOWED_USERS",
        allow_all_env="DWS_PERSONAL_ALLOW_ALL_USERS",
        platform_hint=(
            "You are replying through the owner's personal DingTalk account via Foursday. "
            "Use natural concise Chinese unless the conversation indicates otherwise."
        ),
        emoji="🧭",
    )


__all__ = ["DwsPersonalAdapter", "create_adapter", "register"]
