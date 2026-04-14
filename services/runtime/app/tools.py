from __future__ import annotations

import asyncio
import json
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import get_settings
from app.schemas import ToolPolicy


class ToolPolicyError(RuntimeError):
    pass


class ToolRunner:
    def __init__(self) -> None:
        self.settings = get_settings()

    async def run(self, tool_name: str, args: dict[str, Any], policy: ToolPolicy, run_id: str) -> dict[str, Any]:
        if tool_name not in policy.allowedTools:
            raise ToolPolicyError(f"Tool {tool_name} is not allowed for this mission")
        if tool_name == "shell":
            return await self._run_shell(args, policy, run_id)
        if tool_name == "filesystem":
            return await self._run_filesystem(args, policy, run_id)
        if tool_name == "api":
            return await self._run_api(args, policy)
        if tool_name == "web":
            return await self._run_web(args, policy)
        raise ToolPolicyError(f"Unknown tool {tool_name}")

    def _mission_workspace(self, run_id: str) -> Path:
        workspace = Path(self.settings.workspace_root) / run_id
        workspace.mkdir(parents=True, exist_ok=True)
        return workspace

    async def _run_shell(self, args: dict[str, Any], policy: ToolPolicy, run_id: str) -> dict[str, Any]:
        command = args.get("command", "")
        if not command:
            raise ToolPolicyError("Shell tool requires a command")
        first_token = shlex.split(command)[0]
        if policy.shellAllowlist and first_token not in policy.shellAllowlist:
            raise ToolPolicyError(f"Command {first_token} is not in the allowlist")
        if first_token in policy.shellDenylist:
            raise ToolPolicyError(f"Command {first_token} is denied")

        process = await asyncio.create_subprocess_shell(
            command,
            cwd=str(self._mission_workspace(run_id)),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=policy.maxRuntimeSeconds
            )
        except TimeoutError as exc:
            process.kill()
            raise ToolPolicyError("Shell command timed out") from exc

        return {
            "returncode": process.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
        }

    async def _run_filesystem(self, args: dict[str, Any], policy: ToolPolicy, run_id: str) -> dict[str, Any]:
        action = args.get("action", "list")
        relative_path = args.get("path", ".")
        workspace = self._mission_workspace(run_id)
        candidate = (workspace / relative_path).resolve()
        allowed_roots = [Path(root).resolve() for root in policy.writableRoots] + [workspace.resolve()]
        if not any(str(candidate).startswith(str(root)) for root in allowed_roots):
            raise ToolPolicyError(f"Path {candidate} is outside mission writable roots")

        if action == "list":
            return {"entries": sorted(item.name for item in candidate.iterdir())}
        if action == "read":
            return {"content": candidate.read_text(encoding="utf-8")}
        if action == "write":
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text(args.get("content", ""), encoding="utf-8")
            return {"written": str(candidate)}
        raise ToolPolicyError(f"Unsupported filesystem action {action}")

    async def _run_api(self, args: dict[str, Any], policy: ToolPolicy) -> dict[str, Any]:
        url = args.get("url")
        if not url:
            raise ToolPolicyError("API tool requires a url")
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        if policy.domainAllowlist and hostname not in policy.domainAllowlist:
            raise ToolPolicyError(f"Domain {hostname} is not in the allowlist")

        method = args.get("method", "GET").upper()
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.request(
                method,
                url,
                params=args.get("params"),
                json=args.get("json"),
                headers=args.get("headers"),
            )
        return {
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "body": response.text[:8000],
        }

    async def _run_web(self, args: dict[str, Any], policy: ToolPolicy) -> dict[str, Any]:
        url = args.get("url")
        if not url:
            raise ToolPolicyError("Web tool requires a url")
        parsed = urlparse(url)
        hostname = parsed.hostname or ""
        if policy.domainAllowlist and hostname not in policy.domainAllowlist:
            raise ToolPolicyError(f"Domain {hostname} is not in the allowlist")

        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            raise ToolPolicyError("Playwright is not installed for the web tool") from exc

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, wait_until="networkidle", timeout=30000)
            title = await page.title()
            body_text = await page.locator("body").inner_text()
            await browser.close()
        return {"title": title, "content": body_text[:8000]}

    @staticmethod
    def artifact_payload(result: dict[str, Any]) -> str:
        return json.dumps(result, indent=2, ensure_ascii=True)
