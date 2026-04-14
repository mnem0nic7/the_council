import { z } from "zod";

export const ProviderModeSchema = z.enum(["local", "hosted"]);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string(),
  label: z.string(),
  mode: ProviderModeSchema,
  model: z.string(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(1200),
  enabled: z.boolean().default(true)
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ToolNameSchema = z.enum(["shell", "filesystem", "web", "api"]);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const ToolPolicySchema = z.object({
  allowedTools: z.array(ToolNameSchema).default([]),
  domainAllowlist: z.array(z.string()).default([]),
  shellAllowlist: z.array(z.string()).default([]),
  shellDenylist: z.array(z.string()).default([]),
  writableRoots: z.array(z.string()).default([]),
  maxRuntimeSeconds: z.number().int().positive().default(300),
  maxArtifacts: z.number().int().positive().default(20),
  maxTokens: z.number().int().positive().default(4000)
});
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const MemoryProfileSchema = z.object({
  mode: z.enum(["session", "long_term", "hybrid"]).default("hybrid"),
  namespace: z.string().default("bridge"),
  topK: z.number().int().positive().default(5)
});
export type MemoryProfile = z.infer<typeof MemoryProfileSchema>;

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  description: z.string().default(""),
  systemPrompt: z.string(),
  provider: ProviderConfigSchema,
  tools: z.array(ToolNameSchema).default([]),
  toolPolicy: ToolPolicySchema,
  memoryProfile: MemoryProfileSchema,
  handoffTargets: z.array(z.string()).default([]),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional()
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export const MissionAgentDefinitionSchema = AgentDefinitionSchema.extend({
  missionId: z.string(),
  templateAgentId: z.string().optional()
});
export type MissionAgentDefinition = z.infer<typeof MissionAgentDefinitionSchema>;

export const WorkflowNodeTypeSchema = z.enum([
  "agent",
  "tool",
  "router",
  "parallel",
  "memory",
  "delay",
  "human_input",
  "terminal"
]);
export type WorkflowNodeType = z.infer<typeof WorkflowNodeTypeSchema>;

export const WorkflowNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: WorkflowNodeTypeSchema,
  description: z.string().default(""),
  position: z.object({
    x: z.number(),
    y: z.number()
  }),
  config: z.record(z.any()).default({})
});
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().default(""),
  condition: z.string().optional()
});
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>;

export const WorkflowDefinitionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().default(""),
    version: z.number().int().positive().default(1),
    nodes: z.array(WorkflowNodeSchema).min(1),
    edges: z.array(WorkflowEdgeSchema),
    createdAt: z.string().datetime().optional(),
    updatedAt: z.string().datetime().optional()
  })
  .superRefine((definition, ctx) => {
    const nodeIds = new Set<string>();

    for (const node of definition.nodes) {
      if (nodeIds.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes"],
          message: `Duplicate node id: ${node.id}`
        });
      }
      nodeIds.add(node.id);
    }

    for (const edge of definition.edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["edges"],
          message: `Edge ${edge.id} references an unknown node`
        });
      }
    }
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export const MissionStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled"
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionWorkspaceStatusSchema = z.enum([
  "draft",
  "queued",
  "running",
  "paused",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled"
]);
export type MissionWorkspaceStatus = z.infer<typeof MissionWorkspaceStatusSchema>;

export const MissionWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  status: MissionWorkspaceStatusSchema,
  templateWorkflowId: z.string().optional(),
  workflowDefinition: WorkflowDefinitionSchema,
  defaultInput: z.record(z.any()).default({}),
  defaultProviderOverrides: z.record(z.any()).default({}),
  activeRunId: z.string().optional(),
  latestRunId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MissionWorkspace = z.infer<typeof MissionWorkspaceSchema>;

export const MissionRunSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  name: z.string(),
  status: MissionStatusSchema,
  input: z.record(z.any()).default({}),
  output: z.record(z.any()).default({}),
  currentNodes: z.array(z.string()).default([]),
  providerOverrides: z.record(z.any()).default({}),
  controlState: z.record(z.any()).default({}),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional()
});
export type MissionRun = z.infer<typeof MissionRunSchema>;

export const TelemetrySeveritySchema = z.enum(["info", "warning", "error"]);
export type TelemetrySeverity = z.infer<typeof TelemetrySeveritySchema>;

export const TelemetryEventSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.string(),
  severity: TelemetrySeveritySchema,
  agentId: z.string().optional(),
  nodeId: z.string().optional(),
  message: z.string(),
  data: z.record(z.any()).default({}),
  createdAt: z.string().datetime()
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string(),
  missionId: z.string().optional(),
  runId: z.string().optional(),
  agentId: z.string().optional(),
  namespace: z.string(),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.any()).default({}),
  createdAt: z.string().datetime()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const ArtifactRecordSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  runId: z.string(),
  nodeId: z.string().optional(),
  kind: z.string(),
  label: z.string(),
  uri: z.string(),
  contentText: z.string().default(""),
  metadata: z.record(z.any()).default({}),
  createdAt: z.string().datetime()
});
export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;

export const StreamTokenEventSchema = z.object({
  type: z.literal("node.stream_token"),
  nodeId: z.string(),
  token: z.string(),
  sequence: z.number().int().nonnegative(),
  runId: z.string(),
});
export type StreamTokenEvent = z.infer<typeof StreamTokenEventSchema>;

export const MissionActionSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "retask", "disable_tool"]),
  payload: z.record(z.any()).default({})
});
export type MissionAction = z.infer<typeof MissionActionSchema>;

export const LoginRequestSchema = z.object({
  username: z.string(),
  password: z.string()
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal("bearer"),
  username: z.string()
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const RuntimeSettingsSchema = z.object({
  providers: z.array(ProviderConfigSchema),
  defaultPolicy: ToolPolicySchema,
  storage: z.object({
    artifactRoot: z.string(),
    memoryNamespace: z.string(),
    artifactBackend: z.string().default("filesystem"),
    artifactBucket: z.string().default("council-artifacts")
  })
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;
