from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/council.db"
    redis_url: str = "redis://localhost:6379/0"
    artifact_root: str = "./data/artifacts"
    workspace_root: str = "./data/workspaces"
    object_store_endpoint: str | None = None
    object_store_access_key: str | None = None
    object_store_secret_key: str | None = None
    object_store_bucket: str = "council-artifacts"
    object_store_secure: bool = False
    object_store_region: str | None = None
    default_memory_namespace: str = "bridge"
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 720
    council_operator_username: str = Field(default="captain")
    council_operator_password: str = Field(default="bridge123")
    web_origin: str = "http://localhost:3000"
    max_concurrent_llm_calls: int = 5

    def ensure_paths(self) -> None:
        Path(self.artifact_root).mkdir(parents=True, exist_ok=True)
        Path(self.workspace_root).mkdir(parents=True, exist_ok=True)
        Path("./data").mkdir(parents=True, exist_ok=True)

    @property
    def object_store_enabled(self) -> bool:
        return bool(
            self.object_store_endpoint and self.object_store_access_key and self.object_store_secret_key
        )

    @property
    def provider_catalog(self) -> list[dict[str, object]]:
        return [
            {
                "id": "scripted-local",
                "label": "Scripted Local",
                "mode": "local",
                "model": "scripted-local",
                "temperature": 0.1,
                "maxTokens": 512,
                "enabled": True,
            },
            {
                "id": "ollama",
                "label": "Ollama",
                "mode": "local",
                "model": "ollama/llama3.1",
                "baseUrl": "http://localhost:11434",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            },
            {
                "id": "openai",
                "label": "OpenAI",
                "mode": "hosted",
                "model": "gpt-4.1-mini",
                "apiKeyEnv": "OPENAI_API_KEY",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            },
            {
                "id": "anthropic",
                "label": "Anthropic",
                "mode": "hosted",
                "model": "claude-3-5-sonnet-latest",
                "apiKeyEnv": "ANTHROPIC_API_KEY",
                "temperature": 0.2,
                "maxTokens": 1200,
                "enabled": True,
            },
        ]

    @property
    def default_policy(self) -> dict[str, object]:
        return {
            "allowedTools": ["shell", "filesystem", "web", "api"],
            "domainAllowlist": ["example.com", "openai.com", "anthropic.com"],
            "shellAllowlist": ["echo", "ls", "pwd", "cat", "rg", "python", "python3"],
            "shellDenylist": ["rm", "shutdown", "reboot", "mkfs", "dd"],
            "writableRoots": [self.workspace_root],
            "maxRuntimeSeconds": 300,
            "maxArtifacts": 20,
            "maxTokens": 4000,
        }


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.ensure_paths()
    return settings
