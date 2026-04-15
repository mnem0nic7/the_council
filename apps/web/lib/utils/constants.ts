import type { ToolName, WorkflowNodeType } from "@the-council/contracts";

export const stations = [
  { id: "command", label: "Command Deck" },
  { id: "tactical", label: "Tactical" },
  { id: "crew", label: "Crew" },
  { id: "engineering", label: "Engineering" },
  { id: "archive", label: "Archive" }
] as const;

export const toolCatalog: Array<{ id: ToolName; label: string }> = [
  { id: "shell", label: "Shell" },
  { id: "filesystem", label: "Filesystem" },
  { id: "web", label: "Web" },
  { id: "api", label: "API" }
];

export const nodeTypeCatalog: Array<{ id: WorkflowNodeType; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "tool", label: "Tool" },
  { id: "router", label: "Router" },
  { id: "memory", label: "Memory" },
  { id: "delay", label: "Delay" },
  { id: "human_input", label: "Human Input" },
  { id: "terminal", label: "Terminal" },
  { id: "subworkflow", label: "Sub-workflow" },
  { id: "eval",        label: "Eval / Judge"  },
];

export const engineeringPanelStorageKey = "council-engineering-left-panel-width";
export const engineeringPanelDefaultWidth = 47.5;
export const engineeringPanelMinWidth = 32;
export const engineeringPanelMaxWidth = 62;
export const commandPanelStorageKey = "council-command-left-panel-width";
export const commandPanelDefaultWidth = 48;
export const commandPanelMinWidth = 34;
export const commandPanelMaxWidth = 62;

export function clampCommandPanelWidth(value: number): number {
  return Math.min(commandPanelMaxWidth, Math.max(commandPanelMinWidth, value));
}

export function clampEngineeringPanelWidth(value: number): number {
  return Math.min(engineeringPanelMaxWidth, Math.max(engineeringPanelMinWidth, value));
}
