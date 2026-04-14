from __future__ import annotations

import copy
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import create_access_token, decode_access_token, verify_password
from app.db import Base, SessionLocal, engine, get_db
from app.executor import MissionExecutor, apply_operator_action, record_operator_action, sync_mission_from_run
from app.migrations import build_blank_workflow, default_control_state, ensure_runtime_schema
from app.models import (
    Agent,
    Artifact,
    MemoryRecord,
    Mission,
    MissionAgent,
    MissionEvent,
    MissionRun as MissionRunRecord,
    OperatorAction,
    User,
    Workflow,
)
from app.schemas import (
    AgentDefinition,
    ArtifactRecordRead,
    LoginRequest,
    LoginResponse,
    MemoryRecordRead,
    MissionActionRequest,
    MissionAgentDefinition,
    MissionAgentImportRequest,
    MissionReplay,
    MissionRun,
    MissionRunCreate,
    MissionWorkspace,
    MissionWorkspaceCreate,
    MissionWorkspaceUpdate,
    MissionWorkflowUpdate,
    RuntimeSettingsResponse,
    TelemetryEventRead,
    ToolPolicy,
    WorkflowCreate,
    WorkflowDefinition,
)
from app.seed import seed_defaults
from app.telemetry import TelemetryHub


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    ensure_runtime_schema()
    with SessionLocal() as session:
        seed_defaults(session)
    await executor.storage.ensure_ready()
    await telemetry.start()
    yield
    await telemetry.stop()


app = FastAPI(title="The Council Runtime", version="0.2.0", lifespan=lifespan)
settings = get_settings()
telemetry = TelemetryHub()
executor = MissionExecutor(telemetry)
auth_scheme = HTTPBearer(auto_error=False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_origin, "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def to_agent_definition(agent: Agent) -> AgentDefinition:
    return AgentDefinition(
        id=agent.id,
        name=agent.name,
        role=agent.role,
        description=agent.description,
        systemPrompt=agent.system_prompt,
        provider=agent.provider_config,
        tools=agent.tools,
        toolPolicy=agent.tool_policy,
        memoryProfile=agent.memory_profile,
        handoffTargets=agent.handoff_targets,
        createdAt=agent.created_at,
        updatedAt=agent.updated_at,
    )


def to_mission_agent_definition(agent: MissionAgent) -> MissionAgentDefinition:
    return MissionAgentDefinition(
        id=agent.local_id,
        missionId=agent.mission_id,
        templateAgentId=agent.template_agent_id,
        name=agent.name,
        role=agent.role,
        description=agent.description,
        systemPrompt=agent.system_prompt,
        provider=agent.provider_config,
        tools=agent.tools,
        toolPolicy=agent.tool_policy,
        memoryProfile=agent.memory_profile,
        handoffTargets=agent.handoff_targets,
        createdAt=agent.created_at,
        updatedAt=agent.updated_at,
    )


def mission_agent_snapshot(agent: MissionAgent) -> dict[str, Any]:
    return to_mission_agent_definition(agent).model_dump(mode="json")


def to_workflow_definition(workflow: Workflow) -> WorkflowDefinition:
    payload = dict(workflow.definition)
    payload["createdAt"] = workflow.created_at
    payload["updatedAt"] = workflow.updated_at
    payload["version"] = workflow.version
    return WorkflowDefinition.model_validate(payload)


def to_mission_workspace(mission: Mission) -> MissionWorkspace:
    definition = mission.workflow_definition or build_blank_workflow()
    template_workflow_id = mission.workflow_id
    if definition.get("id") == "mission-workflow":
        template_workflow_id = None
    return MissionWorkspace(
        id=mission.id,
        name=mission.name,
        description=mission.description,
        status=mission.status or "draft",
        templateWorkflowId=template_workflow_id,
        workflowDefinition=WorkflowDefinition.model_validate(definition),
        defaultInput=mission.input_payload or {},
        defaultProviderOverrides=mission.provider_overrides or {},
        activeRunId=mission.active_run_id,
        latestRunId=mission.latest_run_id,
        createdAt=mission.created_at,
        updatedAt=mission.updated_at or mission.created_at,
    )


def to_mission_run(run: MissionRunRecord) -> MissionRun:
    return MissionRun(
        id=run.id,
        missionId=run.mission_id,
        name=run.name,
        status=run.status,
        input=run.input_payload or {},
        output=run.output_payload or {},
        currentNodes=run.current_nodes or [],
        providerOverrides=run.provider_overrides or {},
        controlState=run.control_state or {},
        createdAt=run.created_at,
        startedAt=run.started_at,
        completedAt=run.completed_at,
    )


def require_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(auth_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing credentials")
    try:
        username = decode_access_token(credentials.credentials)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown user")
    return user


def mission_agents_for(db: Session, mission_id: str) -> list[MissionAgent]:
    return db.scalars(select(MissionAgent).where(MissionAgent.mission_id == mission_id).order_by(MissionAgent.name)).all()


def mission_agent_ids_for(db: Session, mission_id: str) -> set[str]:
    return {agent.local_id for agent in mission_agents_for(db, mission_id)}


def validate_workflow_references(definition: WorkflowDefinition, mission_agent_ids: set[str]) -> None:
    for node in definition.nodes:
        agent_id = node.config.get("agentId")
        if node.type in {"agent", "tool"}:
            if not isinstance(agent_id, str) or not agent_id:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"Node {node.id} requires config.agentId",
                )
            if agent_id not in mission_agent_ids:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"Node {node.id} references unknown mission agent {agent_id}",
                )


def active_run_for_mission(db: Session, mission: Mission) -> MissionRunRecord | None:
    if not mission.active_run_id:
        return None
    return db.get(MissionRunRecord, mission.active_run_id)


def ensure_structural_edit_allowed(db: Session, mission: Mission) -> MissionRunRecord | None:
    active_run = active_run_for_mission(db, mission)
    if active_run and active_run.status != "paused":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Pause the active run before editing mission agents or workflow",
        )
    return active_run


def validate_paused_run_workflow_update(run: MissionRunRecord, definition: WorkflowDefinition) -> None:
    completed_nodes = set((run.execution_state or {}).get("completedNodes", []))
    if not completed_nodes:
        return

    current_definition = WorkflowDefinition.model_validate(run.workflow_snapshot)
    current_nodes = {node.id: node for node in current_definition.nodes}
    proposed_nodes = {node.id: node for node in definition.nodes}

    def incoming_sources(workflow_definition: WorkflowDefinition, node_id: str) -> list[str]:
        return sorted(edge.source for edge in workflow_definition.edges if edge.target == node_id)

    for node_id in completed_nodes:
        if node_id not in proposed_nodes:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Completed node {node_id} cannot be removed from a paused run",
            )
        if proposed_nodes[node_id].model_dump(mode="json") != current_nodes[node_id].model_dump(mode="json"):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Completed node {node_id} cannot be changed in a paused run",
            )
        if incoming_sources(current_definition, node_id) != incoming_sources(definition, node_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Completed node {node_id} cannot change predecessors in a paused run",
            )


def update_paused_run_agent_snapshot(db: Session, run: MissionRunRecord) -> None:
    snapshot = [
        mission_agent_snapshot(agent)
        for agent in mission_agents_for(db, run.mission_id)
    ]
    run.agent_snapshot = snapshot


def create_mission_agent_from_template(mission_id: str, template: Agent) -> MissionAgent:
    return MissionAgent(
        mission_id=mission_id,
        local_id=template.id,
        template_agent_id=template.id,
        name=template.name,
        role=template.role,
        description=template.description,
        system_prompt=template.system_prompt,
        provider_config=copy.deepcopy(template.provider_config),
        tools=copy.deepcopy(template.tools),
        tool_policy=copy.deepcopy(template.tool_policy),
        memory_profile=copy.deepcopy(template.memory_profile),
        handoff_targets=copy.deepcopy(template.handoff_targets),
    )


def import_template_agents_for_workflow(db: Session, mission_id: str, definition: WorkflowDefinition) -> None:
    existing = mission_agent_ids_for(db, mission_id)
    for template_agent_id in sorted({node.config.get("agentId") for node in definition.nodes if isinstance(node.config.get("agentId"), str)}):
        if template_agent_id in existing:
            continue
        template = db.get(Agent, template_agent_id)
        if template is None:
            continue
        db.add(create_mission_agent_from_template(mission_id, template))
        existing.add(template_agent_id)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/health")
def api_health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, db: Annotated[Session, Depends(get_db)]) -> LoginResponse:
    user = db.scalar(select(User).where(User.username == payload.username))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    return LoginResponse(accessToken=create_access_token(user.username), username=user.username)


@app.get("/api/v1/settings/runtime", response_model=RuntimeSettingsResponse)
def runtime_settings(_: Annotated[User, Depends(require_user)]) -> RuntimeSettingsResponse:
    return RuntimeSettingsResponse(
        providers=settings.provider_catalog,
        defaultPolicy=ToolPolicy.model_validate(settings.default_policy),
        storage={
            "artifactRoot": settings.artifact_root,
            "memoryNamespace": settings.default_memory_namespace,
            "artifactBackend": "object-store" if settings.object_store_enabled else "filesystem",
            "artifactBucket": settings.object_store_bucket,
        },
    )


@app.get("/api/v1/agents", response_model=list[AgentDefinition])
def list_agents(_: Annotated[User, Depends(require_user)], db: Annotated[Session, Depends(get_db)]) -> list[AgentDefinition]:
    return [to_agent_definition(agent) for agent in db.scalars(select(Agent).order_by(Agent.name)).all()]


@app.post("/api/v1/agents", response_model=AgentDefinition)
def create_agent(
    payload: AgentDefinition,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> AgentDefinition:
    agent = Agent(
        id=payload.id,
        name=payload.name,
        role=payload.role,
        description=payload.description,
        system_prompt=payload.systemPrompt,
        provider_config=payload.provider.model_dump(),
        tools=payload.tools,
        tool_policy=payload.toolPolicy.model_dump(),
        memory_profile=payload.memoryProfile.model_dump(),
        handoff_targets=payload.handoffTargets,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return to_agent_definition(agent)


@app.put("/api/v1/agents/{agent_id}", response_model=AgentDefinition)
def update_agent(
    agent_id: str,
    payload: AgentDefinition,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> AgentDefinition:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    agent.name = payload.name
    agent.role = payload.role
    agent.description = payload.description
    agent.system_prompt = payload.systemPrompt
    agent.provider_config = payload.provider.model_dump()
    agent.tools = payload.tools
    agent.tool_policy = payload.toolPolicy.model_dump()
    agent.memory_profile = payload.memoryProfile.model_dump()
    agent.handoff_targets = payload.handoffTargets
    db.commit()
    db.refresh(agent)
    return to_agent_definition(agent)


@app.delete("/api/v1/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_agent(
    agent_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    agent = db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    db.delete(agent)
    db.commit()


@app.get("/api/v1/workflows", response_model=list[WorkflowDefinition])
def list_workflows(
    _: Annotated[User, Depends(require_user)], db: Annotated[Session, Depends(get_db)]
) -> list[WorkflowDefinition]:
    return [to_workflow_definition(workflow) for workflow in db.scalars(select(Workflow).order_by(Workflow.name)).all()]


@app.post("/api/v1/workflows", response_model=WorkflowDefinition)
def create_workflow(
    payload: WorkflowCreate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkflowDefinition:
    definition = payload.definition
    workflow = Workflow(
        id=definition.id,
        name=definition.name,
        description=definition.description,
        version=definition.version,
        definition=definition.model_dump(mode="json"),
    )
    db.add(workflow)
    db.commit()
    db.refresh(workflow)
    return to_workflow_definition(workflow)


@app.put("/api/v1/workflows/{workflow_id}", response_model=WorkflowDefinition)
def update_workflow(
    workflow_id: str,
    payload: WorkflowCreate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkflowDefinition:
    workflow = db.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    definition = payload.definition
    workflow.name = definition.name
    workflow.description = definition.description
    workflow.version = definition.version
    workflow.definition = definition.model_dump(mode="json")
    db.commit()
    db.refresh(workflow)
    return to_workflow_definition(workflow)


@app.delete("/api/v1/workflows/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workflow(
    workflow_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    workflow = db.get(Workflow, workflow_id)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    db.delete(workflow)
    db.commit()


@app.get("/api/v1/missions", response_model=list[MissionWorkspace])
def list_missions(
    _: Annotated[User, Depends(require_user)], db: Annotated[Session, Depends(get_db)]
) -> list[MissionWorkspace]:
    return [to_mission_workspace(mission) for mission in db.scalars(select(Mission).order_by(Mission.created_at.desc())).all()]


@app.post("/api/v1/missions", response_model=MissionWorkspace, status_code=status.HTTP_201_CREATED)
def create_mission(
    payload: MissionWorkspaceCreate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionWorkspace:
    workflow_definition = build_blank_workflow()
    template_workflow_id = payload.templateWorkflowId
    if payload.templateWorkflowId:
        workflow = db.get(Workflow, payload.templateWorkflowId)
        if workflow is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow template not found")
        workflow_definition = copy.deepcopy(workflow.definition)
    elif db.scalar(select(func.count(Workflow.id))) or 0:
        # Preserve compatibility with older deployments where the missions.workflow_id column may still be non-null.
        template_workflow_id = db.scalar(select(Workflow.id).order_by(Workflow.name).limit(1))

    mission = Mission(
        workflow_id=template_workflow_id,
        name=payload.name,
        description=payload.description,
        status="draft",
        input_payload=payload.defaultInput,
        output_payload={},
        current_nodes=[],
        provider_overrides=payload.defaultProviderOverrides,
        control_state=default_control_state(),
        workflow_definition=workflow_definition,
        active_run_id=None,
        latest_run_id=None,
    )
    db.add(mission)
    db.flush()

    definition = WorkflowDefinition.model_validate(workflow_definition)
    import_template_agents_for_workflow(db, mission.id, definition)

    db.commit()
    db.refresh(mission)
    return to_mission_workspace(mission)


@app.get("/api/v1/missions/{mission_id}", response_model=MissionWorkspace)
def get_mission(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionWorkspace:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    return to_mission_workspace(mission)


@app.put("/api/v1/missions/{mission_id}", response_model=MissionWorkspace)
def update_mission(
    mission_id: str,
    payload: MissionWorkspaceUpdate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionWorkspace:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")

    mission.name = payload.name
    mission.description = payload.description
    mission.input_payload = payload.defaultInput
    mission.provider_overrides = payload.defaultProviderOverrides
    db.commit()
    db.refresh(mission)
    return to_mission_workspace(mission)


@app.delete("/api/v1/missions/{mission_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    for record in db.scalars(select(MemoryRecord).where(MemoryRecord.mission_id == mission_id)).all():
        db.delete(record)
    for action in db.scalars(select(OperatorAction).where(OperatorAction.mission_id == mission_id)).all():
        db.delete(action)
    db.delete(mission)
    db.commit()


@app.get("/api/v1/missions/{mission_id}/agents", response_model=list[MissionAgentDefinition])
def list_mission_agents(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[MissionAgentDefinition]:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    return [to_mission_agent_definition(agent) for agent in mission_agents_for(db, mission_id)]


@app.post("/api/v1/missions/{mission_id}/agents", response_model=MissionAgentDefinition, status_code=status.HTTP_201_CREATED)
def create_mission_agent(
    mission_id: str,
    payload: MissionAgentDefinition,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionAgentDefinition:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    paused_run = ensure_structural_edit_allowed(db, mission)
    if payload.id in mission_agent_ids_for(db, mission_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Mission agent {payload.id} already exists")

    agent = MissionAgent(
        mission_id=mission_id,
        local_id=payload.id,
        template_agent_id=payload.templateAgentId,
        name=payload.name,
        role=payload.role,
        description=payload.description,
        system_prompt=payload.systemPrompt,
        provider_config=payload.provider.model_dump(),
        tools=payload.tools,
        tool_policy=payload.toolPolicy.model_dump(),
        memory_profile=payload.memoryProfile.model_dump(),
        handoff_targets=payload.handoffTargets,
    )
    db.add(agent)
    db.flush()
    if paused_run is not None:
        update_paused_run_agent_snapshot(db, paused_run)
    db.commit()
    db.refresh(agent)
    return to_mission_agent_definition(agent)


@app.post("/api/v1/missions/{mission_id}/agents/import", response_model=MissionAgentDefinition, status_code=status.HTTP_201_CREATED)
def import_mission_agent(
    mission_id: str,
    payload: MissionAgentImportRequest,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionAgentDefinition:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    paused_run = ensure_structural_edit_allowed(db, mission)
    template = db.get(Agent, payload.templateAgentId)
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent template not found")
    if template.id in mission_agent_ids_for(db, mission_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Mission agent {template.id} already exists")

    agent = create_mission_agent_from_template(mission_id, template)
    db.add(agent)
    db.flush()
    if paused_run is not None:
        update_paused_run_agent_snapshot(db, paused_run)
    db.commit()
    db.refresh(agent)
    return to_mission_agent_definition(agent)


@app.put("/api/v1/missions/{mission_id}/agents/{mission_agent_id}", response_model=MissionAgentDefinition)
def update_mission_agent(
    mission_id: str,
    mission_agent_id: str,
    payload: MissionAgentDefinition,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionAgentDefinition:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    paused_run = ensure_structural_edit_allowed(db, mission)
    agent = db.scalar(
        select(MissionAgent).where(MissionAgent.mission_id == mission_id, MissionAgent.local_id == mission_agent_id)
    )
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission agent not found")
    if payload.id != mission_agent_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Mission agent id cannot be changed after creation")

    agent.template_agent_id = payload.templateAgentId
    agent.name = payload.name
    agent.role = payload.role
    agent.description = payload.description
    agent.system_prompt = payload.systemPrompt
    agent.provider_config = payload.provider.model_dump()
    agent.tools = payload.tools
    agent.tool_policy = payload.toolPolicy.model_dump()
    agent.memory_profile = payload.memoryProfile.model_dump()
    agent.handoff_targets = payload.handoffTargets
    if paused_run is not None:
        update_paused_run_agent_snapshot(db, paused_run)
    db.commit()
    db.refresh(agent)
    return to_mission_agent_definition(agent)


@app.delete("/api/v1/missions/{mission_id}/agents/{mission_agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission_agent(
    mission_id: str,
    mission_agent_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> None:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    paused_run = ensure_structural_edit_allowed(db, mission)
    agent = db.scalar(
        select(MissionAgent).where(MissionAgent.mission_id == mission_id, MissionAgent.local_id == mission_agent_id)
    )
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission agent not found")

    definition = WorkflowDefinition.model_validate(mission.workflow_definition or build_blank_workflow())
    for node in definition.nodes:
        if node.config.get("agentId") == mission_agent_id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Mission agent {mission_agent_id} is still referenced by workflow node {node.id}",
            )

    db.delete(agent)
    if paused_run is not None:
        update_paused_run_agent_snapshot(db, paused_run)
    db.commit()


@app.get("/api/v1/missions/{mission_id}/workflow", response_model=WorkflowDefinition)
def get_mission_workflow(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkflowDefinition:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    return WorkflowDefinition.model_validate(mission.workflow_definition or build_blank_workflow())


@app.put("/api/v1/missions/{mission_id}/workflow", response_model=WorkflowDefinition)
def update_mission_workflow(
    mission_id: str,
    payload: MissionWorkflowUpdate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> WorkflowDefinition:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    paused_run = ensure_structural_edit_allowed(db, mission)
    definition = payload.definition
    validate_workflow_references(definition, mission_agent_ids_for(db, mission_id))
    if paused_run is not None:
        validate_paused_run_workflow_update(paused_run, definition)
        paused_run.workflow_snapshot = definition.model_dump(mode="json")
    mission.workflow_definition = definition.model_dump(mode="json")
    db.commit()
    return definition


@app.get("/api/v1/missions/{mission_id}/runs", response_model=list[MissionRun])
def list_mission_runs(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[MissionRun]:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    runs = db.scalars(select(MissionRunRecord).where(MissionRunRecord.mission_id == mission_id).order_by(MissionRunRecord.created_at.desc())).all()
    return [to_mission_run(run) for run in runs]


@app.post("/api/v1/missions/{mission_id}/runs", response_model=MissionRun, status_code=status.HTTP_201_CREATED)
async def launch_mission_run(
    mission_id: str,
    payload: MissionRunCreate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    active_run = active_run_for_mission(db, mission)
    if active_run and active_run.status in {"queued", "running", "paused", "awaiting_input"}:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Mission already has an active run")

    workflow_definition = WorkflowDefinition.model_validate(mission.workflow_definition or build_blank_workflow())
    mission_agents = mission_agents_for(db, mission_id)
    validate_workflow_references(workflow_definition, {agent.local_id for agent in mission_agents})
    next_run_number = db.scalar(select(func.count(MissionRunRecord.id)).where(MissionRunRecord.mission_id == mission_id)) or 0
    run = MissionRunRecord(
        mission_id=mission_id,
        name=payload.name or f"{mission.name} Run {next_run_number + 1}",
        status="queued",
        input_payload=payload.input or mission.input_payload or {},
        output_payload={},
        current_nodes=[],
        provider_overrides=payload.providerOverrides or mission.provider_overrides or {},
        control_state=default_control_state(),
        workflow_snapshot=workflow_definition.model_dump(mode="json"),
        agent_snapshot=[mission_agent_snapshot(agent) for agent in mission_agents],
        execution_state={"results": {}, "completedNodes": []},
    )
    db.add(run)
    db.flush()
    sync_mission_from_run(mission, run)
    db.commit()
    db.refresh(run)
    executor.start(run.id)
    return to_mission_run(run)


@app.get("/api/v1/missions/{mission_id}/runs/{run_id}", response_model=MissionRun)
def get_mission_run(
    mission_id: str,
    run_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    run = db.get(MissionRunRecord, run_id)
    if run is None or run.mission_id != mission_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    return to_mission_run(run)


@app.post("/api/v1/missions/{mission_id}/runs/{run_id}/actions", response_model=MissionRun)
async def mission_run_action(
    mission_id: str,
    run_id: str,
    payload: MissionActionRequest,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    mission = db.get(Mission, mission_id)
    run = db.get(MissionRunRecord, run_id)
    if mission is None or run is None or run.mission_id != mission_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")

    apply_operator_action(run, payload.action, payload.payload)
    sync_mission_from_run(mission, run)
    db.commit()
    db.refresh(run)
    record_operator_action(mission_id, run_id, payload.action, payload.payload)
    telemetry.persist_event(
        db,
        mission_id,
        run_id,
        "mission.operator_action",
        f"Operator action: {payload.action}",
        severity="warning" if payload.action in {"pause", "cancel", "disable_tool"} else "info",
        data=payload.payload | {"action": payload.action},
    )
    if payload.action == "resume":
        executor.start(run_id)
    return to_mission_run(run)


@app.get("/api/v1/missions/{mission_id}/runs/{run_id}/replay", response_model=MissionReplay)
def replay_mission_run(
    mission_id: str,
    run_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionReplay:
    run = db.get(MissionRunRecord, run_id)
    if run is None or run.mission_id != mission_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found")
    artifacts = db.scalars(select(Artifact).where(Artifact.run_id == run_id)).all()
    events = db.scalars(
        select(MissionEvent).where(MissionEvent.run_id == run_id).order_by(MissionEvent.sequence)
    ).all()
    memories = db.scalars(select(MemoryRecord).where(MemoryRecord.run_id == run_id)).all()

    return MissionReplay(
        mission=to_mission_run(run),
        events=[
            TelemetryEventRead(
                id=event.id,
                missionId=event.mission_id,
                runId=event.run_id or run_id,
                sequence=event.sequence,
                type=event.event_type,
                severity=event.severity,
                nodeId=event.node_id,
                agentId=event.agent_id,
                message=event.message,
                data=event.payload,
                createdAt=event.created_at,
            )
            for event in events
        ],
        artifacts=[
            ArtifactRecordRead(
                id=artifact.id,
                missionId=artifact.mission_id,
                runId=artifact.run_id or run_id,
                nodeId=artifact.node_id,
                kind=artifact.kind,
                label=artifact.label,
                uri=artifact.uri,
                contentText=artifact.content_text,
                metadata=artifact.metadata_json,
                createdAt=artifact.created_at,
            )
            for artifact in artifacts
        ],
        memories=[
            MemoryRecordRead(
                id=record.id,
                missionId=record.mission_id,
                runId=record.run_id,
                agentId=record.mission_agent_id or record.agent_id,
                namespace=record.namespace,
                content=record.content,
                tags=record.tags,
                metadata=record.metadata_json,
                createdAt=record.created_at,
            )
            for record in memories
        ],
    )


@app.websocket("/ws/runs/{run_id}")
async def run_stream(websocket: WebSocket, run_id: str, token: Annotated[str, Query()]) -> None:
    try:
        decode_access_token(token)
    except Exception:  # noqa: BLE001
        await websocket.close(code=4401)
        return
    await telemetry.connect(run_id, websocket)
    try:
        with SessionLocal() as session:
            events = session.scalars(
                select(MissionEvent).where(MissionEvent.run_id == run_id).order_by(MissionEvent.sequence)
            ).all()
            await websocket.send_json(
                {
                    "type": "history",
                    "events": [
                        TelemetryEventRead(
                            id=event.id,
                            missionId=event.mission_id,
                            runId=event.run_id or run_id,
                            sequence=event.sequence,
                            type=event.event_type,
                            severity=event.severity,
                            nodeId=event.node_id,
                            agentId=event.agent_id,
                            message=event.message,
                            data=event.payload,
                            createdAt=event.created_at,
                        ).model_dump(mode="json")
                        for event in events
                    ],
                }
            )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        telemetry.disconnect(run_id, websocket)
    finally:
        telemetry.disconnect(run_id, websocket)
