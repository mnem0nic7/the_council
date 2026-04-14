from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.sqlite import JSON as SQLiteJSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, index=True)
    role: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    system_prompt: Mapped[str] = mapped_column(Text)
    provider_config: Mapped[dict] = mapped_column(SQLiteJSON)
    tools: Mapped[list[str]] = mapped_column(SQLiteJSON)
    tool_policy: Mapped[dict] = mapped_column(SQLiteJSON)
    memory_profile: Mapped[dict] = mapped_column(SQLiteJSON)
    handoff_targets: Mapped[list[str]] = mapped_column(SQLiteJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Workflow(Base):
    __tablename__ = "workflows"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    version: Mapped[int] = mapped_column(Integer, default=1)
    definition: Mapped[dict] = mapped_column(SQLiteJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Mission(Base):
    __tablename__ = "missions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    workflow_id: Mapped[str | None] = mapped_column(ForeignKey("workflows.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="draft")
    input_payload: Mapped[dict] = mapped_column(SQLiteJSON)
    output_payload: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    current_nodes: Mapped[list[str]] = mapped_column(SQLiteJSON, default=list)
    provider_overrides: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    control_state: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    workflow_definition: Mapped[dict | None] = mapped_column(SQLiteJSON, nullable=True)
    active_run_id: Mapped[str | None] = mapped_column(String, nullable=True)
    latest_run_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    workflow: Mapped["Workflow | None"] = relationship()
    mission_agents: Mapped[list["MissionAgent"]] = relationship(back_populates="mission", cascade="all, delete-orphan")
    runs: Mapped[list["MissionRun"]] = relationship(back_populates="mission", cascade="all, delete-orphan")
    events: Mapped[list["MissionEvent"]] = relationship(back_populates="mission", cascade="all, delete-orphan")
    artifacts: Mapped[list["Artifact"]] = relationship(back_populates="mission", cascade="all, delete-orphan")


class MissionAgent(Base):
    __tablename__ = "mission_agents"
    __table_args__ = (UniqueConstraint("mission_id", "local_id", name="uq_mission_agents_mission_local"),)

    key: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str] = mapped_column(ForeignKey("missions.id"), index=True)
    local_id: Mapped[str] = mapped_column(String)
    template_agent_id: Mapped[str | None] = mapped_column(String, nullable=True)
    name: Mapped[str] = mapped_column(String, index=True)
    role: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    system_prompt: Mapped[str] = mapped_column(Text)
    provider_config: Mapped[dict] = mapped_column(SQLiteJSON)
    tools: Mapped[list[str]] = mapped_column(SQLiteJSON)
    tool_policy: Mapped[dict] = mapped_column(SQLiteJSON)
    memory_profile: Mapped[dict] = mapped_column(SQLiteJSON)
    handoff_targets: Mapped[list[str]] = mapped_column(SQLiteJSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    mission: Mapped["Mission"] = relationship(back_populates="mission_agents")


class MissionRun(Base):
    __tablename__ = "mission_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str] = mapped_column(ForeignKey("missions.id"), index=True)
    name: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="queued")
    input_payload: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    output_payload: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    current_nodes: Mapped[list[str]] = mapped_column(SQLiteJSON, default=list)
    provider_overrides: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    control_state: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    workflow_snapshot: Mapped[dict] = mapped_column(SQLiteJSON)
    agent_snapshot: Mapped[list[dict]] = mapped_column(SQLiteJSON, default=list)
    execution_state: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    mission: Mapped["Mission"] = relationship(back_populates="runs")


class MissionEvent(Base):
    __tablename__ = "mission_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str] = mapped_column(ForeignKey("missions.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("mission_runs.id"), nullable=True, index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String)
    severity: Mapped[str] = mapped_column(String, default="info")
    agent_id: Mapped[str | None] = mapped_column(String, nullable=True)
    node_id: Mapped[str | None] = mapped_column(String, nullable=True)
    message: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    mission: Mapped["Mission"] = relationship(back_populates="events")


class Artifact(Base):
    __tablename__ = "artifacts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str] = mapped_column(ForeignKey("missions.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("mission_runs.id"), nullable=True, index=True)
    node_id: Mapped[str | None] = mapped_column(String, nullable=True)
    kind: Mapped[str] = mapped_column(String)
    label: Mapped[str] = mapped_column(String)
    uri: Mapped[str] = mapped_column(String)
    content_text: Mapped[str] = mapped_column(Text, default="")
    metadata_json: Mapped[dict] = mapped_column("metadata", SQLiteJSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    mission: Mapped["Mission"] = relationship(back_populates="artifacts")


class MemoryRecord(Base):
    __tablename__ = "memory_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str | None] = mapped_column(ForeignKey("missions.id"), nullable=True, index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("mission_runs.id"), nullable=True, index=True)
    agent_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    mission_agent_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    namespace: Mapped[str] = mapped_column(String, index=True)
    content: Mapped[str] = mapped_column(Text)
    tags: Mapped[list[str]] = mapped_column(SQLiteJSON, default=list)
    metadata_json: Mapped[dict] = mapped_column("metadata", SQLiteJSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class OperatorAction(Base):
    __tablename__ = "operator_actions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    mission_id: Mapped[str] = mapped_column(ForeignKey("missions.id"), index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("mission_runs.id"), nullable=True, index=True)
    action: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(SQLiteJSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
