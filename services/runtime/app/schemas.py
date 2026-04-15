from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class ProviderConfig(BaseModel):
    id: str
    label: str
    mode: Literal["local", "hosted"]
    model: str
    baseUrl: str | None = None
    apiKeyEnv: str | None = None
    temperature: float = 0.2
    maxTokens: int = 1200
    enabled: bool = True


class ToolPolicy(BaseModel):
    allowedTools: list[Literal["shell", "filesystem", "web", "api"]] = Field(default_factory=list)
    domainAllowlist: list[str] = Field(default_factory=list)
    shellAllowlist: list[str] = Field(default_factory=list)
    shellDenylist: list[str] = Field(default_factory=list)
    writableRoots: list[str] = Field(default_factory=list)
    maxRuntimeSeconds: int = 300
    maxArtifacts: int = 20
    maxTokens: int = 4000


class MemoryProfile(BaseModel):
    mode: Literal["session", "long_term", "hybrid"] = "hybrid"
    namespace: str = "bridge"
    topK: int = 5


class AgentBase(BaseModel):
    id: str
    name: str
    role: str
    description: str = ""
    systemPrompt: str
    provider: ProviderConfig
    tools: list[Literal["shell", "filesystem", "web", "api"]] = Field(default_factory=list)
    toolPolicy: ToolPolicy
    memoryProfile: MemoryProfile
    handoffTargets: list[str] = Field(default_factory=list)


class AgentDefinition(AgentBase):
    createdAt: datetime | None = None
    updatedAt: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class MissionAgentDefinition(AgentDefinition):
    missionId: str
    templateAgentId: str | None = None


class WorkflowNode(BaseModel):
    id: str
    name: str
    type: Literal["agent", "tool", "router", "parallel", "memory", "delay", "human_input", "terminal", "subworkflow"]
    description: str = ""
    position: dict[str, float]
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowEdge(BaseModel):
    id: str
    source: str
    target: str
    label: str = ""
    condition: str | None = None


class WorkflowDefinition(BaseModel):
    id: str
    name: str
    description: str = ""
    version: int = 1
    nodes: list[WorkflowNode]
    edges: list[WorkflowEdge]
    createdAt: datetime | None = None
    updatedAt: datetime | None = None

    model_config = ConfigDict(from_attributes=True)

    @field_validator("nodes")
    @classmethod
    def validate_nodes(cls, nodes: list[WorkflowNode]) -> list[WorkflowNode]:
        ids = [node.id for node in nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("Workflow node ids must be unique")
        return nodes

    @model_validator(mode="after")
    def validate_graph(self) -> "WorkflowDefinition":
        node_ids = {node.id for node in self.nodes}
        adjacency: dict[str, list[str]] = {node.id: [] for node in self.nodes}
        indegree: dict[str, int] = {node.id: 0 for node in self.nodes}

        for edge in self.edges:
            if edge.source not in node_ids or edge.target not in node_ids:
                raise ValueError(f"Edge {edge.id} references an unknown node")
            adjacency[edge.source].append(edge.target)
            indegree[edge.target] += 1

        queue = [node_id for node_id, degree in indegree.items() if degree == 0]
        visited = 0

        while queue:
            current = queue.pop(0)
            visited += 1
            for target in adjacency[current]:
                indegree[target] -= 1
                if indegree[target] == 0:
                    queue.append(target)

        if visited != len(self.nodes):
            raise ValueError("Workflow graph must be acyclic")

        return self


class WorkflowCreate(BaseModel):
    definition: WorkflowDefinition


class MissionWorkspaceCreate(BaseModel):
    name: str
    description: str = ""
    templateWorkflowId: str | None = None
    defaultInput: dict[str, Any] = Field(default_factory=lambda: {"prompt": "", "route": "analysis"})
    defaultProviderOverrides: dict[str, Any] = Field(default_factory=dict)


class MissionWorkspaceUpdate(BaseModel):
    name: str
    description: str = ""
    defaultInput: dict[str, Any] = Field(default_factory=lambda: {"prompt": "", "route": "analysis"})
    defaultProviderOverrides: dict[str, Any] = Field(default_factory=dict)


class MissionAgentImportRequest(BaseModel):
    templateAgentId: str


class MissionWorkflowUpdate(BaseModel):
    definition: WorkflowDefinition


class MissionRunCreate(BaseModel):
    name: str | None = None
    input: dict[str, Any] = Field(default_factory=dict)
    providerOverrides: dict[str, Any] = Field(default_factory=dict)


class MissionActionRequest(BaseModel):
    action: Literal["pause", "resume", "cancel", "retask", "disable_tool", "provide_input"]
    payload: dict[str, Any] = Field(default_factory=dict)


class MissionWorkspace(BaseModel):
    id: str
    name: str
    description: str = ""
    status: Literal["draft", "queued", "running", "paused", "awaiting_input", "completed", "failed", "cancelled"]
    templateWorkflowId: str | None = None
    workflowDefinition: WorkflowDefinition
    defaultInput: dict[str, Any] = Field(default_factory=dict)
    defaultProviderOverrides: dict[str, Any] = Field(default_factory=dict)
    activeRunId: str | None = None
    latestRunId: str | None = None
    createdAt: datetime
    updatedAt: datetime

    model_config = ConfigDict(from_attributes=True)


class MissionRun(BaseModel):
    id: str
    missionId: str
    name: str
    status: Literal["queued", "running", "paused", "awaiting_input", "completed", "failed", "cancelled"]
    input: dict[str, Any]
    output: dict[str, Any]
    currentNodes: list[str]
    providerOverrides: dict[str, Any]
    controlState: dict[str, Any]
    createdAt: datetime
    startedAt: datetime | None = None
    completedAt: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class TelemetryEventRead(BaseModel):
    id: str
    missionId: str
    runId: str
    sequence: int
    type: str
    severity: Literal["info", "warning", "error"]
    agentId: str | None = None
    nodeId: str | None = None
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    createdAt: datetime


class ArtifactRecordRead(BaseModel):
    id: str
    missionId: str
    runId: str
    nodeId: str | None = None
    kind: str
    label: str
    uri: str
    contentText: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
    createdAt: datetime


class MemoryRecordRead(BaseModel):
    id: str
    missionId: str | None = None
    runId: str | None = None
    agentId: str | None = None
    namespace: str
    content: str
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    createdAt: datetime


class MissionReplay(BaseModel):
    mission: MissionRun
    events: list[TelemetryEventRead]
    artifacts: list[ArtifactRecordRead]
    memories: list[MemoryRecordRead]


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    accessToken: str
    tokenType: str = "bearer"
    username: str


class RuntimeSettingsResponse(BaseModel):
    providers: list[ProviderConfig]
    defaultPolicy: ToolPolicy
    storage: dict[str, str]
