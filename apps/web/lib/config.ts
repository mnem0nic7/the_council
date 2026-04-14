function browserOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

function resolveHttpBase(configured: string | undefined, fallbackPath: string): string {
  const origin = browserOrigin();

  if (!configured || configured === "auto" || configured === "same-origin") {
    return origin ? `${origin}${fallbackPath}` : `http://localhost:8000${fallbackPath}`;
  }

  if (configured.startsWith("/")) {
    return origin ? `${origin}${configured}` : `http://localhost:3000${configured}`;
  }

  return configured;
}

function resolveWsBase(configured: string | undefined, fallbackPath: string): string {
  const origin = browserOrigin();

  if (!configured || configured === "auto" || configured === "same-origin") {
    if (!origin) {
      return `ws://localhost:8000${fallbackPath}`;
    }
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = fallbackPath;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  if (configured.startsWith("/")) {
    if (!origin) {
      return `ws://localhost:8000${configured}`;
    }
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = configured;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  return configured;
}

export function getRuntimeUrl(): string {
  return resolveHttpBase(process.env.NEXT_PUBLIC_RUNTIME_URL, "/api/v1");
}

export function getWsBaseUrl(): string {
  return resolveWsBase(process.env.NEXT_PUBLIC_WS_URL, "/ws");
}
