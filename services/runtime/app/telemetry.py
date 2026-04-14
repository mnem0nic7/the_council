from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket
from redis.asyncio import Redis
from redis.asyncio.client import PubSub
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models import MissionEvent
from app.schemas import TelemetryEventRead

logger = logging.getLogger(__name__)


class TelemetryHub:
    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._redis: Redis | None = None
        self._pubsub: PubSub | None = None
        self._listener_task: asyncio.Task[None] | None = None
        self._instance_id = str(uuid.uuid4())
        self._settings = get_settings()

    async def start(self) -> None:
        try:
            self._redis = Redis.from_url(self._settings.redis_url, decode_responses=True)
            await self._redis.ping()
            self._pubsub = self._redis.pubsub()
            await self._pubsub.psubscribe("telemetry:runs:*")
            self._listener_task = asyncio.create_task(self._listen())
        except RedisError as exc:
            logger.warning("Redis telemetry unavailable, falling back to local fanout: %s", exc)
            self._redis = None
            self._pubsub = None
            self._listener_task = None

    async def stop(self) -> None:
        if self._listener_task is not None:
            self._listener_task.cancel()
            try:
                await self._listener_task
            except asyncio.CancelledError:
                pass
        if self._pubsub is not None:
            await self._pubsub.close()
        if self._redis is not None:
            await self._redis.aclose()
        self._listener_task = None
        self._pubsub = None
        self._redis = None

    async def connect(self, run_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[run_id].add(websocket)

    def disconnect(self, run_id: str, websocket: WebSocket) -> None:
        self._connections[run_id].discard(websocket)
        if not self._connections[run_id]:
            self._connections.pop(run_id, None)

    async def broadcast(self, run_id: str, payload: dict[str, Any]) -> None:
        for socket in list(self._connections.get(run_id, set())):
            try:
                await socket.send_json(payload)
            except Exception:  # noqa: BLE001
                self.disconnect(run_id, socket)

    async def dispatch(self, run_id: str, payload: dict[str, Any]) -> None:
        await self.broadcast(run_id, payload)
        if self._redis is None:
            return
        envelope = json.dumps({"source": self._instance_id, "event": payload})
        try:
            await self._redis.publish(f"telemetry:runs:{run_id}", envelope)
        except RedisError as exc:
            logger.warning("Redis publish failed for run %s: %s", run_id, exc)

    async def _listen(self) -> None:
        if self._pubsub is None:
            return
        try:
            async for message in self._pubsub.listen():
                if message.get("type") != "pmessage" or "data" not in message:
                    continue
                envelope = json.loads(message["data"])
                if envelope.get("source") == self._instance_id:
                    continue
                channel = str(message.get("channel", ""))
                run_id = channel.rsplit(":", 1)[-1]
                await self.broadcast(run_id, envelope["event"])
        except asyncio.CancelledError:
            raise
        except RedisError as exc:
            logger.warning("Redis subscription loop stopped: %s", exc)

    def persist_event(
        self,
        session: Session,
        mission_id: str,
        run_id: str,
        event_type: str,
        message: str,
        *,
        severity: str = "info",
        node_id: str | None = None,
        agent_id: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> TelemetryEventRead:
        current_max = session.scalar(
            select(func.max(MissionEvent.sequence)).where(MissionEvent.run_id == run_id)
        )
        event = MissionEvent(
            mission_id=mission_id,
            run_id=run_id,
            sequence=(current_max or 0) + 1,
            event_type=event_type,
            severity=severity,
            node_id=node_id,
            agent_id=agent_id,
            message=message,
            payload=data or {},
            created_at=datetime.now(UTC),
        )
        session.add(event)
        session.commit()
        session.refresh(event)
        event_read = TelemetryEventRead(
            id=event.id,
            missionId=event.mission_id,
            runId=run_id,
            sequence=event.sequence,
            type=event.event_type,
            severity=event.severity,
            nodeId=event.node_id,
            agentId=event.agent_id,
            message=event.message,
            data=event.payload,
            createdAt=event.created_at,
        )
        self._schedule_dispatch(run_id, event_read.model_dump(mode="json"))
        return event_read

    async def dispatch_stream_token(
        self,
        run_id: str,
        node_id: str,
        token: str,
        sequence: int,
    ) -> None:
        """Broadcast a streaming token to WebSocket clients without persisting to DB."""
        payload = {
            "type": "node.stream_token",
            "nodeId": node_id,
            "token": token,
            "sequence": sequence,
            "runId": run_id,
        }
        await self.broadcast(run_id, payload)
        if self._redis is not None:
            envelope = json.dumps({"source": self._instance_id, "event": payload})
            try:
                await self._redis.publish(f"telemetry:runs:{run_id}", envelope)
            except RedisError as exc:
                logger.warning("Redis stream token publish failed for run %s: %s", run_id, exc)

    def _schedule_dispatch(self, run_id: str, payload: dict[str, Any]) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(self.dispatch(run_id, payload))
            return
        loop.create_task(self.dispatch(run_id, payload))
