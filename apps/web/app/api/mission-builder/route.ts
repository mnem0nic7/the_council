import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";

const SYSTEM_PROMPT = `You are the Mission Builder AI for The Council — a starship agent mission control platform.
You help operators design and create missions, agents, and workflows through conversation.
When the operator asks you to create something, use the appropriate tool.
Always confirm what you created and explain what each piece does.
Be concise and use the platform's military/space aesthetic in your language.`;

const tools: Anthropic.Tool[] = [
  {
    name: "create_mission",
    description: "Create a new mission workspace",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Mission name" },
        description: { type: "string", description: "What this mission does" },
        prompt: { type: "string", description: "Default mission prompt / objective" }
      },
      required: ["name"]
    }
  },
  {
    name: "create_mission_agent",
    description: "Add an agent to an existing mission",
    input_schema: {
      type: "object" as const,
      properties: {
        missionId: { type: "string", description: "ID of the mission to add the agent to" },
        name: { type: "string", description: "Agent call sign / name" },
        role: { type: "string", description: "Agent role (e.g. analyst, executor, coordinator)" },
        systemPrompt: { type: "string", description: "System prompt that defines the agent's behaviour" },
        tools: {
          type: "array",
          items: { type: "string", enum: ["shell", "filesystem", "web", "api"] },
          description: "Tools the agent is allowed to use"
        }
      },
      required: ["missionId", "name", "role", "systemPrompt"]
    }
  },
  {
    name: "create_template_agent",
    description: "Create a reusable template agent (not tied to a specific mission)",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        systemPrompt: { type: "string" },
        tools: {
          type: "array",
          items: { type: "string", enum: ["shell", "filesystem", "web", "api"] }
        }
      },
      required: ["name", "role", "systemPrompt"]
    }
  }
];

const RUNTIME_URL = process.env.RUNTIME_URL ?? "http://localhost:8000/api/v1";

async function backendRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await fetch(`${RUNTIME_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {})
    },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

type ActionPerformed = { type: string; name: string };

export async function POST(req: Request) {
  try {
    const { messages, token } = (await req.json()) as {
      messages: { role: "user" | "assistant"; content: string }[];
      token: string;
    };

    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
    }

    const client = new Anthropic();

    // Fetch live context to ground Claude
    const [missionsResult, agentsResult, settingsResult] = await Promise.allSettled([
      backendRequest<{ id: string; name: string }[]>("/missions", token),
      backendRequest<{ id: string; name: string }[]>("/agents", token),
      backendRequest<{
        providers: { id: string }[];
        storage: { memoryNamespace: string };
        defaultPolicy: Record<string, unknown>;
      }>("/settings/runtime", token)
    ]);

    const missionList = missionsResult.status === "fulfilled" ? missionsResult.value : [];
    const agentList = agentsResult.status === "fulfilled" ? agentsResult.value : [];
    const settingsData = settingsResult.status === "fulfilled" ? settingsResult.value : null;

    const contextNote = [
      `Current missions: ${missionList.length > 0 ? missionList.map((m) => `${m.name} (id: ${m.id})`).join(", ") : "none"}`,
      `Template agents: ${agentList.length > 0 ? agentList.map((a) => a.name).join(", ") : "none"}`
    ].join("\n");

    const systemWithContext = `${SYSTEM_PROMPT}\n\nCurrent state:\n${contextNote}`;

    const actionsPerformed: ActionPerformed[] = [];
    let finalText = "";

    let loopMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content
    }));

    for (let step = 0; step < 6; step++) {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: systemWithContext,
        tools,
        messages: loopMessages
      });

      if (response.stop_reason === "end_turn") {
        finalText = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        break;
      }

      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        loopMessages = [...loopMessages, { role: "assistant", content: response.content }];

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const input = toolUse.input as Record<string, unknown>;
          let result = "";
          try {
            if (toolUse.name === "create_mission") {
              const created = await backendRequest<{ id: string; name: string }>(
                "/missions",
                token,
                {
                  method: "POST",
                  body: JSON.stringify({
                    name: input.name,
                    description: input.description ?? "",
                    defaultInput: { prompt: input.prompt ?? "" }
                  })
                }
              );
              actionsPerformed.push({ type: "mission", name: created.name });
              result = JSON.stringify({ success: true, id: created.id, name: created.name });
            } else if (toolUse.name === "create_mission_agent") {
              const providerId = settingsData?.providers[0]?.id ?? "default";
              const defaultPolicy = settingsData?.defaultPolicy ?? {};
              const agentPayload = {
                id: `agent-${Date.now()}`,
                missionId: input.missionId,
                name: input.name,
                role: input.role,
                description: "",
                systemPrompt: input.systemPrompt,
                provider: {
                  id: providerId,
                  label: providerId,
                  mode: "hosted",
                  model: "claude-sonnet-4-6",
                  temperature: 0.2,
                  maxTokens: 1200,
                  enabled: true
                },
                tools: input.tools ?? [],
                toolPolicy: { ...defaultPolicy, allowedTools: input.tools ?? [] },
                memoryProfile: {
                  mode: "hybrid",
                  namespace: settingsData?.storage.memoryNamespace ?? "bridge",
                  topK: 5
                },
                handoffTargets: []
              };
              const created = await backendRequest<{ id: string; name: string }>(
                `/missions/${String(input.missionId)}/agents`,
                token,
                { method: "POST", body: JSON.stringify(agentPayload) }
              );
              actionsPerformed.push({ type: "mission_agent", name: created.name });
              result = JSON.stringify({ success: true, id: created.id, name: created.name });
            } else if (toolUse.name === "create_template_agent") {
              const providerId = settingsData?.providers[0]?.id ?? "default";
              const defaultPolicy = settingsData?.defaultPolicy ?? {};
              const agentPayload = {
                id: `template-agent-${Date.now()}`,
                name: input.name,
                role: input.role,
                description: "",
                systemPrompt: input.systemPrompt,
                provider: {
                  id: providerId,
                  label: providerId,
                  mode: "hosted",
                  model: "claude-sonnet-4-6",
                  temperature: 0.2,
                  maxTokens: 1200,
                  enabled: true
                },
                tools: input.tools ?? [],
                toolPolicy: { ...defaultPolicy, allowedTools: input.tools ?? [] },
                memoryProfile: {
                  mode: "hybrid",
                  namespace: settingsData?.storage.memoryNamespace ?? "bridge",
                  topK: 5
                },
                handoffTargets: []
              };
              const created = await backendRequest<{ id: string; name: string }>(
                "/agents",
                token,
                { method: "POST", body: JSON.stringify(agentPayload) }
              );
              actionsPerformed.push({ type: "template_agent", name: created.name });
              result = JSON.stringify({ success: true, id: created.id, name: created.name });
            }
          } catch (toolErr) {
            result = JSON.stringify({
              success: false,
              error: toolErr instanceof Error ? toolErr.message : "Tool failed"
            });
          }

          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
        }

        loopMessages = [...loopMessages, { role: "user", content: toolResults }];
      }
    }

    return NextResponse.json({
      message: finalText || "Mission Builder completed the request.",
      actionsPerformed
    });
  } catch (err) {
    console.error("[mission-builder]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
