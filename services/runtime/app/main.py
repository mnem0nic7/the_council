from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import create_access_token, decode_access_token, verify_password
from app.db import Base, SessionLocal, engine, get_db
from app.executor import MissionExecutor, apply_operator_action, record_operator_action
from app.models import Agent, Artifact, MemoryRecord, Mission, MissionEvent, User, Workflow
from app.schemas import (
    AgentDefinition,
    ArtifactRecordRead,
    LoginRequest,
    LoginResponse,
    MemoryRecordRead,
    MissionActionRequest,
    MissionCreate,
    MissionReplay,
    MissionRun,
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
    with SessionLocal() as session:
        seed_defaults(session)
    await executor.storage.ensure_ready()
    await telemetry.start()
    yield
    await telemetry.stop()


app = FastAPI(title="The Council Runtime", version="0.1.0", lifespan=lifespan)
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


def to_workflow_definition(workflow: Workflow) -> WorkflowDefinition:
    payload = dict(workflow.definition)
    payload["createdAt"] = workflow.created_at
    payload["updatedAt"] = workflow.updated_at
    payload["version"] = workflow.version
    return WorkflowDefinition.model_validate(payload)


def to_mission_run(mission: Mission) -> MissionRun:
    return MissionRun(
        id=mission.id,
        workflowId=mission.workflow_id,
        name=mission.name,
        status=mission.status,
        input=mission.input_payload,
        output=mission.output_payload or {},
        currentNodes=mission.current_nodes or [],
        providerOverrides=mission.provider_overrides or {},
        controlState=mission.control_state or {},
        createdAt=mission.created_at,
        startedAt=mission.started_at,
        completedAt=mission.completed_at,
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


@app.get("/api/v1/missions", response_model=list[MissionRun])
def list_missions(
    _: Annotated[User, Depends(require_user)], db: Annotated[Session, Depends(get_db)]
) -> list[MissionRun]:
    return [to_mission_run(mission) for mission in db.scalars(select(Mission).order_by(Mission.created_at.desc())).all()]


@app.post("/api/v1/missions", response_model=MissionRun, status_code=status.HTTP_201_CREATED)
async def launch_mission(
    payload: MissionCreate,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    workflow = db.get(Workflow, payload.workflowId)
    if workflow is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workflow not found")
    mission = Mission(
        workflow_id=workflow.id,
        name=payload.name,
        status="queued",
        input_payload=payload.input,
        output_payload={},
        current_nodes=[],
        provider_overrides=payload.providerOverrides,
        control_state={"paused": False, "cancelled": False, "retask_notes": [], "disabled_tools": []},
    )
    db.add(mission)
    db.commit()
    db.refresh(mission)
    executor.start(mission.id)
    return to_mission_run(mission)


@app.get("/api/v1/missions/{mission_id}", response_model=MissionRun)
def get_mission(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    return to_mission_run(mission)


@app.post("/api/v1/missions/{mission_id}/actions", response_model=MissionRun)
async def mission_action(
    mission_id: str,
    payload: MissionActionRequest,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionRun:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    apply_operator_action(mission, payload.action, payload.payload)
    db.commit()
    db.refresh(mission)
    record_operator_action(mission_id, payload.action, payload.payload)
    telemetry.persist_event(
        db,
        mission_id,
        "mission.operator_action",
        f"Operator action: {payload.action}",
        severity="warning" if payload.action in {"pause", "cancel", "disable_tool"} else "info",
        data=payload.payload | {"action": payload.action},
    )
    if payload.action == "resume":
        executor.start(mission_id)
    return to_mission_run(mission)


@app.get("/api/v1/missions/{mission_id}/replay", response_model=MissionReplay)
def replay_mission(
    mission_id: str,
    _: Annotated[User, Depends(require_user)],
    db: Annotated[Session, Depends(get_db)],
) -> MissionReplay:
    mission = db.get(Mission, mission_id)
    if mission is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Mission not found")
    artifacts = db.scalars(select(Artifact).where(Artifact.mission_id == mission_id)).all()
    events = db.scalars(
        select(MissionEvent).where(MissionEvent.mission_id == mission_id).order_by(MissionEvent.sequence)
    ).all()
    return MissionReplay(
        mission=to_mission_run(mission),
        events=[
            TelemetryEventRead(
                id=event.id,
                missionId=event.mission_id,
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
                agentId=record.agent_id,
                namespace=record.namespace,
                content=record.content,
                tags=record.tags,
                metadata=record.metadata_json,
                createdAt=record.created_at,
            )
            for record in db.scalars(select(MemoryRecord).where(MemoryRecord.mission_id == mission_id)).all()
        ],
    )


@app.websocket("/ws/missions/{mission_id}")
async def mission_stream(websocket: WebSocket, mission_id: str, token: Annotated[str, Query()]) -> None:
    try:
        decode_access_token(token)
    except Exception:  # noqa: BLE001
        await websocket.close(code=4401)
        return
    await telemetry.connect(mission_id, websocket)
    try:
        with SessionLocal() as session:
            events = session.scalars(
                select(MissionEvent).where(MissionEvent.mission_id == mission_id).order_by(MissionEvent.sequence)
            ).all()
            await websocket.send_json(
                {
                    "type": "history",
                    "events": [
                        TelemetryEventRead(
                            id=event.id,
                            missionId=event.mission_id,
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
        telemetry.disconnect(mission_id, websocket)
    finally:
        telemetry.disconnect(mission_id, websocket)
