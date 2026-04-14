from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import hash_password
from app.models import Agent, User, Workflow


def seed_defaults(session: Session) -> None:
    settings = get_settings()
    user = session.scalar(select(User).where(User.username == settings.council_operator_username))
    if user is None:
        session.add(
            User(
                username=settings.council_operator_username,
                password_hash=hash_password(settings.council_operator_password),
            )
        )

    if session.get(Agent, "captain") is None:
        base_policy = settings.default_policy
        scripted_provider = settings.provider_catalog[0]
        agents = [
            Agent(
                id="captain",
                name="Captain",
                role="mission-commander",
                description="Sets mission direction and overall route.",
                system_prompt="You are the captain of a starship AI mission. Produce concise actionable steps.",
                provider_config=scripted_provider,
                tools=["api", "web"],
                tool_policy=base_policy,
                memory_profile={"mode": "hybrid", "namespace": "bridge", "topK": 5},
                handoff_targets=["navigator", "engineer"],
            ),
            Agent(
                id="navigator",
                name="Navigator",
                role="route-analyst",
                description="Breaks missions into navigable subtasks and branch recommendations.",
                system_prompt="You are the navigator. Translate goals into routes and checkpoints.",
                provider_config=scripted_provider,
                tools=["web", "api"],
                tool_policy=base_policy,
                memory_profile={"mode": "hybrid", "namespace": "tactical", "topK": 5},
                handoff_targets=["engineer"],
            ),
            Agent(
                id="engineer",
                name="Engineering Officer",
                role="tool-operator",
                description="Uses shell and filesystem tools to produce mission artifacts.",
                system_prompt="You are the chief engineer. Execute safely and summarize outcomes.",
                provider_config=scripted_provider,
                tools=["shell", "filesystem", "api"],
                tool_policy=base_policy,
                memory_profile={"mode": "hybrid", "namespace": "engineering", "topK": 5},
                handoff_targets=["archivist"],
            ),
            Agent(
                id="archivist",
                name="Archivist",
                role="memory-officer",
                description="Stores mission learnings and final reports.",
                system_prompt="You are the archivist. Capture mission state and long-term memory.",
                provider_config=scripted_provider,
                tools=["filesystem"],
                tool_policy=base_policy,
                memory_profile={"mode": "hybrid", "namespace": "archive", "topK": 5},
                handoff_targets=[],
            ),
        ]
        session.add_all(agents)

    if session.get(Workflow, "bridge-assessment") is None:
        workflow = Workflow(
            id="bridge-assessment",
            name="Bridge Assessment Mission",
            description="Branching and parallel sample mission for the cockpit.",
            version=1,
            definition={
                "id": "bridge-assessment",
                "name": "Bridge Assessment Mission",
                "description": "Evaluate an operator prompt, branch by route, run engineering and archive stages.",
                "version": 1,
                "nodes": [
                    {
                        "id": "captain-intake",
                        "name": "Captain Intake",
                        "type": "agent",
                        "position": {"x": 80, "y": 120},
                        "config": {
                            "agentId": "captain",
                            "promptTemplate": (
                                "Mission prompt: {{mission.input.prompt}}\n"
                                "Requested route={{mission.input.route}}\n"
                                "Return a route marker if one is present."
                            ),
                        },
                    },
                    {
                        "id": "route-decision",
                        "name": "Route Decision",
                        "type": "router",
                        "position": {"x": 320, "y": 120},
                        "config": {"route": "{{mission.input.route}}"},
                    },
                    {
                        "id": "navigator-brief",
                        "name": "Navigator Brief",
                        "type": "agent",
                        "position": {"x": 560, "y": 40},
                        "config": {
                            "agentId": "navigator",
                            "promptTemplate": "Build a tactical brief for {{mission.input.prompt}} based on {{results.captain-intake.output}}",
                        },
                    },
                    {
                        "id": "engineering-scan",
                        "name": "Engineering Scan",
                        "type": "tool",
                        "position": {"x": 560, "y": 220},
                        "config": {
                            "agentId": "engineer",
                            "tool": "shell",
                            "args": {"command": "echo mission-ready > engineering_report.txt && ls"},
                        },
                    },
                    {
                        "id": "archive-memory",
                        "name": "Archive Memory",
                        "type": "memory",
                        "position": {"x": 820, "y": 120},
                        "config": {
                            "mode": "write",
                            "namespace": "archive",
                            "content": "{{results.navigator-brief.output}} {{results.engineering-scan.result.stdout}}",
                        },
                    },
                    {
                        "id": "mission-log",
                        "name": "Mission Log",
                        "type": "terminal",
                        "position": {"x": 1060, "y": 120},
                        "config": {
                            "output": {
                                "brief": "{{results.navigator-brief.output}}",
                                "engineering": "{{results.engineering-scan.result.stdout}}",
                                "memory": "{{results.archive-memory.content}}",
                            }
                        },
                    },
                ],
                "edges": [
                    {"id": "e1", "source": "captain-intake", "target": "route-decision"},
                    {"id": "e2", "source": "route-decision", "target": "navigator-brief", "condition": "analysis"},
                    {"id": "e3", "source": "route-decision", "target": "engineering-scan", "condition": "analysis"},
                    {"id": "e4", "source": "navigator-brief", "target": "archive-memory"},
                    {"id": "e5", "source": "engineering-scan", "target": "archive-memory"},
                    {"id": "e6", "source": "archive-memory", "target": "mission-log"},
                ],
            },
        )
        session.add(workflow)

    session.commit()

