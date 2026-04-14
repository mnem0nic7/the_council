from __future__ import annotations

import asyncio
import os
from typing import Any, AsyncIterator

from litellm import acompletion

from app.core.config import get_settings
from app.schemas import ProviderConfig


class ProviderService:
    def __init__(self) -> None:
        settings = get_settings()
        self._semaphore = asyncio.Semaphore(settings.max_concurrent_llm_calls)

    async def complete(
        self,
        provider: ProviderConfig,
        *,
        system_prompt: str,
        user_prompt: str,
    ) -> str:
        if provider.id == "scripted-local" or provider.model == "scripted-local":
            return self._scripted_response(system_prompt, user_prompt)

        request: dict[str, Any] = {
            "model": provider.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": provider.temperature,
            "max_tokens": provider.maxTokens,
        }
        if provider.baseUrl:
            request["api_base"] = provider.baseUrl
        if provider.apiKeyEnv:
            api_key = os.getenv(provider.apiKeyEnv)
            if api_key:
                request["api_key"] = api_key

        async with self._semaphore:
            response = await acompletion(**request)
        return response.choices[0].message.content or ""

    async def stream_complete(
        self,
        provider: ProviderConfig,
        *,
        system_prompt: str,
        user_prompt: str,
    ) -> AsyncIterator[str]:
        """Async generator yielding completion tokens one at a time."""
        if provider.id == "scripted-local" or provider.model == "scripted-local":
            # Yield scripted response word by word for testing
            response = self._scripted_response(system_prompt, user_prompt)
            for word in response.split():
                yield word + " "
            return

        request: dict[str, Any] = {
            "model": provider.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": provider.temperature,
            "max_tokens": provider.maxTokens,
            "stream": True,
        }
        if provider.baseUrl:
            request["api_base"] = provider.baseUrl
        if provider.apiKeyEnv:
            api_key = os.getenv(provider.apiKeyEnv)
            if api_key:
                request["api_key"] = api_key

        async with self._semaphore:
            response = await acompletion(**request)
            async for chunk in response:
                token = chunk.choices[0].delta.content or ""
                if token:
                    yield token

    def _scripted_response(self, system_prompt: str, user_prompt: str) -> str:
        preview = user_prompt.replace("\n", " ").strip()[:240]
        if "route=" in preview:
            route = preview.split("route=", 1)[1].split()[0]
            return f"ROUTE:{route}\n{preview}"
        return (
            "Mission analysis complete.\n"
            f"System stance: {system_prompt[:80]}\n"
            f"Operator input: {preview}"
        )

