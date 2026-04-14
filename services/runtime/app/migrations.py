from __future__ import annotations

import copy
from datetime import UTC, datetime

from sqlalchemy import inspect, select, text

from app.db import SessionLocal, engine
from app.models import Agent, Artifact, MemoryRecord, Mission, MissionAgent, MissionEvent, MissionRun, OperatorAction, Workflow


def default_control_state() -> dict[str, object]:
    return {"paused": False, "cancelled": False, "retask_notes": [], "disabled_tools": []}


def build_blank_workflow() -> dict[str, object]:
    return {
        "id": "mission-workflow",
        "name": "Mission Workflow",
        "description": "Blank mission workflow",
        "version": 1,
        "nodes": [
            {
                "id": "mission-terminal",
                "name": "Mission Terminal",
                "type": "terminal",
                "description": "",
                "position": {"x": 160, "y": 120},
                "config": {"output": "{{results}}"},
            }
        ],
        "edges": [],
    }


def referenced_agent_ids(definition: dict[str, object] | None) -> list[str]:
    if not isinstance(definition, dict):
        return []
    agent_ids: list[str] = []
    for node in definition.get("nodes", []):
        if not isinstance(node, dict):
            continue
        config = node.get("config", {})
        if isinstance(config, dict) and isinstance(config.get("agentId"), str):
            agent_ids.append(config["agentId"])
    return sorted(set(agent_ids))


def ensure_runtime_schema() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    if "missions" not in tables:
        return
    dialect = engine.dialect.name
    timestamp_type = "TIMESTAMP WITH TIME ZONE" if dialect == "postgresql" else "DATETIME"
    json_type = "JSONB" if dialect == "postgresql" else "JSON"

    mission_columns = {column["name"] for column in inspector.get_columns("missions")}
    event_columns = {column["name"] for column in inspector.get_columns("mission_events")} if "mission_events" in tables else set()
    artifact_columns = {column["name"] for column in inspector.get_columns("artifacts")} if "artifacts" in tables else set()
    memory_columns = {column["name"] for column in inspector.get_columns("memory_records")} if "memory_records" in tables else set()
    action_columns = {column["name"] for column in inspector.get_columns("operator_actions")} if "operator_actions" in tables else set()

    statements: list[str] = []
    if "description" not in mission_columns:
        statements.append("ALTER TABLE missions ADD COLUMN description TEXT DEFAULT ''")
    if "workflow_definition" not in mission_columns:
        statements.append(f"ALTER TABLE missions ADD COLUMN workflow_definition {json_type}")
    if "active_run_id" not in mission_columns:
        statements.append("ALTER TABLE missions ADD COLUMN active_run_id VARCHAR")
    if "latest_run_id" not in mission_columns:
        statements.append("ALTER TABLE missions ADD COLUMN latest_run_id VARCHAR")
    if "updated_at" not in mission_columns:
        statements.append(f"ALTER TABLE missions ADD COLUMN updated_at {timestamp_type}")

    if "run_id" not in event_columns and "mission_events" in tables:
        statements.append("ALTER TABLE mission_events ADD COLUMN run_id VARCHAR")
    if "run_id" not in artifact_columns and "artifacts" in tables:
        statements.append("ALTER TABLE artifacts ADD COLUMN run_id VARCHAR")
    if "run_id" not in memory_columns and "memory_records" in tables:
        statements.append("ALTER TABLE memory_records ADD COLUMN run_id VARCHAR")
    if "mission_agent_id" not in memory_columns and "memory_records" in tables:
        statements.append("ALTER TABLE memory_records ADD COLUMN mission_agent_id VARCHAR")
    if "run_id" not in action_columns and "operator_actions" in tables:
        statements.append("ALTER TABLE operator_actions ADD COLUMN run_id VARCHAR")

    if statements:
        with engine.begin() as connection:
            for statement in statements:
                connection.execute(text(statement))
            connection.execute(text("UPDATE missions SET updated_at = created_at WHERE updated_at IS NULL"))
            if "mission_events" in tables:
                connection.execute(text("UPDATE mission_events SET run_id = mission_id WHERE run_id IS NULL"))
            if "artifacts" in tables:
                connection.execute(text("UPDATE artifacts SET run_id = mission_id WHERE run_id IS NULL"))
            if "memory_records" in tables:
                connection.execute(text("UPDATE memory_records SET run_id = mission_id WHERE run_id IS NULL"))
                connection.execute(
                    text("UPDATE memory_records SET mission_agent_id = agent_id WHERE mission_agent_id IS NULL")
                )
            if "operator_actions" in tables:
                connection.execute(text("UPDATE operator_actions SET run_id = mission_id WHERE run_id IS NULL"))

    migrate_legacy_missions()


def migrate_legacy_missions() -> None:
    with SessionLocal() as session:
        legacy_missions = session.scalars(select(Mission).where(Mission.workflow_definition.is_(None))).all()
        if not legacy_missions:
            return

        for mission in legacy_missions:
            workflow_definition = build_blank_workflow()
            if mission.workflow_id:
                workflow = session.get(Workflow, mission.workflow_id)
                if workflow is not None:
                    workflow_definition = copy.deepcopy(workflow.definition)

            mission.workflow_definition = workflow_definition
            mission.description = mission.description or ""
            mission.updated_at = mission.updated_at or mission.created_at

            existing_local_ids = {
                local_id for local_id, in session.execute(
                    select(MissionAgent.local_id).where(MissionAgent.mission_id == mission.id)
                )
            }
            for template_agent_id in referenced_agent_ids(workflow_definition):
                if template_agent_id in existing_local_ids:
                    continue
                template = session.get(Agent, template_agent_id)
                if template is None:
                    continue
                session.add(
                    MissionAgent(
                        mission_id=mission.id,
                        local_id=template.id,
                        template_agent_id=template.id,
                        name=template.name,
                        role=template.role,
                        description=template.description,
                        system_prompt=template.system_prompt,
                        provider_config=template.provider_config,
                        tools=template.tools,
                        tool_policy=template.tool_policy,
                        memory_profile=template.memory_profile,
                        handoff_targets=template.handoff_targets,
                        created_at=mission.created_at,
                        updated_at=mission.updated_at or mission.created_at,
                    )
                )

            session.flush()
            mission_agents = session.scalars(
                select(MissionAgent).where(MissionAgent.mission_id == mission.id).order_by(MissionAgent.name)
            ).all()
            agent_snapshot = [
                {
                    "id": agent.local_id,
                    "missionId": mission.id,
                    "templateAgentId": agent.template_agent_id,
                    "name": agent.name,
                    "role": agent.role,
                    "description": agent.description,
                    "systemPrompt": agent.system_prompt,
                    "provider": agent.provider_config,
                    "tools": agent.tools,
                    "toolPolicy": agent.tool_policy,
                    "memoryProfile": agent.memory_profile,
                    "handoffTargets": agent.handoff_targets,
                    "createdAt": agent.created_at,
                    "updatedAt": agent.updated_at,
                }
                for agent in mission_agents
            ]

            run = session.get(MissionRun, mission.id)
            if run is None:
                run = MissionRun(
                    id=mission.id,
                    mission_id=mission.id,
                    name=mission.name,
                    status=mission.status if mission.status else "completed",
                    input_payload=mission.input_payload or {},
                    output_payload=mission.output_payload or {},
                    current_nodes=mission.current_nodes or [],
                    provider_overrides=mission.provider_overrides or {},
                    control_state=mission.control_state or default_control_state(),
                    workflow_snapshot=copy.deepcopy(workflow_definition),
                    agent_snapshot=agent_snapshot,
                    execution_state={
                        "results": (mission.output_payload or {}).get("results", {}),
                        "completedNodes": [
                            node["id"] for node in workflow_definition.get("nodes", []) if isinstance(node, dict)
                        ]
                        if mission.status in {"completed", "cancelled"}
                        else [],
                    },
                    created_at=mission.created_at,
                    started_at=mission.started_at,
                    completed_at=mission.completed_at,
                )
                session.add(run)

            mission.latest_run_id = run.id
            mission.active_run_id = run.id if run.status in {"queued", "running", "paused", "awaiting_input"} else None
            if mission.status not in {"queued", "running", "paused", "awaiting_input", "completed", "failed", "cancelled"}:
                mission.status = "draft"

        session.commit()
