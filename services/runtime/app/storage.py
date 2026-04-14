from __future__ import annotations

import asyncio
import io
import logging
from dataclasses import dataclass
from pathlib import Path

from app.core.config import get_settings

logger = logging.getLogger(__name__)

try:
    from minio import Minio
    from minio.error import S3Error
except ImportError:  # pragma: no cover
    Minio = None
    S3Error = Exception


@dataclass
class StoredArtifact:
    uri: str
    preview: str
    metadata: dict[str, str]


class ArtifactStorage:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.root = Path(self.settings.artifact_root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._client = None
        self._bucket_ready = False

        if (
            self.settings.object_store_endpoint
            and self.settings.object_store_access_key
            and self.settings.object_store_secret_key
            and Minio is not None
        ):
            self._client = Minio(
                self.settings.object_store_endpoint,
                access_key=self.settings.object_store_access_key,
                secret_key=self.settings.object_store_secret_key,
                secure=self.settings.object_store_secure,
                region=self.settings.object_store_region or None,
            )

    async def ensure_ready(self) -> None:
        if self._client is None or self._bucket_ready:
            return
        await asyncio.to_thread(self._ensure_bucket)

    async def store_text(
        self,
        mission_id: str,
        run_id: str,
        node_id: str,
        kind: str,
        content: str,
        *,
        content_type: str = "application/json",
    ) -> StoredArtifact:
        artifact_dir = self.root / mission_id / run_id
        artifact_dir.mkdir(parents=True, exist_ok=True)
        file_name = f"{node_id}-{kind}.json"
        local_path = artifact_dir / file_name
        local_path.write_text(content, encoding="utf-8")

        metadata = {"storageBackend": "filesystem", "localPath": str(local_path)}
        uri = str(local_path)

        if self._client is not None:
            try:
                await self.ensure_ready()
                object_name = f"{mission_id}/{run_id}/{file_name}"
                await asyncio.to_thread(self._upload_bytes, object_name, content.encode("utf-8"), content_type)
                uri = f"s3://{self.settings.object_store_bucket}/{object_name}"
                metadata = {
                    "storageBackend": "object-store",
                    "bucket": self.settings.object_store_bucket,
                    "objectName": object_name,
                    "localPath": str(local_path),
                }
            except S3Error as exc:
                logger.warning("Object store upload failed for %s/%s: %s", mission_id, file_name, exc)

        return StoredArtifact(uri=uri, preview=content[:8000], metadata=metadata)

    def _ensure_bucket(self) -> None:
        if self._client is None:
            return
        if not self._client.bucket_exists(self.settings.object_store_bucket):
            self._client.make_bucket(self.settings.object_store_bucket)
        self._bucket_ready = True

    def _upload_bytes(self, object_name: str, payload: bytes, content_type: str) -> None:
        if self._client is None:
            return
        self._client.put_object(
            self.settings.object_store_bucket,
            object_name,
            io.BytesIO(payload),
            length=len(payload),
            content_type=content_type,
        )
