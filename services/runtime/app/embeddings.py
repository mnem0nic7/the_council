from __future__ import annotations

from litellm import aembedding

from .core.config import get_settings


async def embed_text(text: str) -> list[float] | None:
    """Generate an embedding for the given text.

    Returns None if embedding is disabled or fails.
    """
    settings = get_settings()
    if not settings.embedding_enabled:
        return None
    try:
        response = await aembedding(
            model=settings.embedding_model,
            input=[text],
        )
        return response.data[0]["embedding"]
    except Exception:  # noqa: BLE001
        return None
