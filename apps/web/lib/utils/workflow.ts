import type { WorkflowDefinition, WorkflowNodeType } from "@the-council/contracts";

export function cloneWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  return JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
}

export function defaultNodeConfig(type: WorkflowNodeType, missionAgentId?: string): Record<string, unknown> {
  if (type === "agent") {
    return {
      agentId: missionAgentId ?? "",
      promptTemplate: "Mission prompt: {{mission.input.prompt}}"
    };
  }
  if (type === "tool") {
    return {
      agentId: missionAgentId ?? "",
      tool: "shell",
      args: {
        command: "echo mission-ready"
      }
    };
  }
  if (type === "router") {
    return {
      route: "{{mission.input.route}}"
    };
  }
  if (type === "memory") {
    return {
      mode: "write",
      namespace: "archive",
      content: "{{results}}"
    };
  }
  if (type === "delay") {
    return {
      seconds: 1
    };
  }
  if (type === "human_input") {
    return {
      defaultInput: "{{mission.input.prompt}}"
    };
  }
  if (type === "subworkflow") {
    return { workflowId: "", inputMapping: {}, outputMapping: {}, maxDepth: 3 };
  }
  if (type === "eval") {
    return { targetNodeId: "", judgeAgentId: missionAgentId ?? "", rubric: "", passThreshold: 0.7, onFail: "continue" };
  }
  return {
    output: "{{results}}"
  };
}

export function nextNodeId(workflow: WorkflowDefinition): string {
  let index = workflow.nodes.length + 1;
  let candidate = `node-${index}`;
  while (workflow.nodes.some((node) => node.id === candidate)) {
    index += 1;
    candidate = `node-${index}`;
  }
  return candidate;
}

export function nextEdgeId(workflow: WorkflowDefinition): string {
  let index = workflow.edges.length + 1;
  let candidate = `edge-${index}`;
  while (workflow.edges.some((edge) => edge.id === candidate)) {
    index += 1;
    candidate = `edge-${index}`;
  }
  return candidate;
}

export function parseConfigJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function configJson(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2);
}
