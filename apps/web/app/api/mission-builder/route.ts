import { GoogleGenerativeAI, SchemaType, type FunctionDeclaration, type Part } from "@google/generative-ai";
import { NextResponse } from "next/server";

const SYSTEM_INSTRUCTION = `You are the Mission Builder AI for The Council — a starship agent mission control platform.
You help operators design and create missions, agents, and workflows through conversation.
When the operator asks you to create something, use the appropriate tool.
Always confirm what you created and explain what each piece does.
Be concise and use the platform's military/space aesthetic in your language.`;

const functionDeclarations: FunctionDeclaration[] = [
  {
    name: "create_mission",
    description: "Create a new mission workspace",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, description: "Mission name" },
        description: { type: SchemaType.STRING, description: "What this mission does" },
        prompt: { type: SchemaType.STRING, description: "Default mission prompt / objective" }
      },
      required: ["name"]
    }
  },
  {
    name: "create_mission_agent",
    description: "Add an agent to an existing mission",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        missionId: { type: SchemaType.STRING, description: "ID of the mission to add the agent to" },
        name: { type: SchemaType.STRING, description: "Agent call sign / name" },
        role: { type: SchemaType.STRING, description: "Agent role (e.g. analyst, executor, coordinator)" },
        systemPrompt: { type: SchemaType.STRING, description: "System prompt that defines the agent's behaviour" },
        tools: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Tools the agent is allowed to use. Valid values: shell, filesystem, web, api"
        }
      },
      required: ["missionId", "name", "role", "systemPrompt"]
    }
  },
  {
    name: "create_template_agent",
    description: "Create a reusable template agent (not tied to a specific mission)",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING, description: "Agent call sign / name" },
        role: { type: SchemaType.STRING, description: "Agent role (e.g. analyst, executor, coordinator)" },
        systemPrompt: { type: SchemaType.STRING, description: "System prompt that defines the agent's behaviour" },
        tools: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Tools the agent is allowed to use. Valid values: shell, filesystem, web, api"
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
    if (!process.env.GEMINI_KEY) {
      return NextResponse.json({ error: "GEMINI_KEY not configured" }, { status: 503 });
    }

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

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      systemInstruction: `${SYSTEM_INSTRUCTION}\n\nCurrent state:\n${contextNote}`,
      tools: [{ functionDeclarations }]
    });

    // Convert prior messages to Gemini history (all except the last user message)
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }]
    }));

    const lastMessage = messages[messages.length - 1];
    const chat = model.startChat({ history });

    const actionsPerformed: ActionPerformed[] = [];
    let finalText = "";

    let result = await chat.sendMessage(lastMessage.content);

    for (let step = 0; step < 6; step++) {
      const functionCalls = result.response.functionCalls();

      if (!functionCalls || functionCalls.length === 0) {
        finalText = result.response.text();
        break;
      }

      const functionResponses: Part[] = [];

      for (const call of functionCalls) {
        const input = call.args as Record<string, unknown>;
        let response: unknown;

        try {
          if (call.name === "create_mission") {
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
            response = { success: true, id: created.id, name: created.name };
          } else if (call.name === "create_mission_agent") {
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
                model: "gemini-2.0-flash",
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
            response = { success: true, id: created.id, name: created.name };
          } else if (call.name === "create_template_agent") {
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
                model: "gemini-2.0-flash",
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
            response = { success: true, id: created.id, name: created.name };
          } else {
            response = { success: false, error: `Unknown function: ${call.name}` };
          }
        } catch (toolErr) {
          response = {
            success: false,
            error: toolErr instanceof Error ? toolErr.message : "Tool failed"
          };
        }

        functionResponses.push({
          functionResponse: { name: call.name, response: response as object }
        });
      }

      result = await chat.sendMessage(functionResponses);
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
