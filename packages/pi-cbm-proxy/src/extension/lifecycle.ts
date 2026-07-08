import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CbmServices } from "../pi-tools/definitions.js";
import { CODEBASE_MEMORY_PROMPT } from "./prompt.js";

const AUTO_REFRESH_INTERVAL_MS = 60_000;

type IndexSession = {
  active: boolean;
  cwd: string;
  signal?: AbortSignal;
  ui?: {
    setStatus(key: string, text: string | undefined): void;
  };
};

function setCbmStatus(session: IndexSession, status: "idx" | "on" | "off") {
  session.ui?.setStatus("codebase-memory", `cbm: ${status}`);
}

export function registerLifecycle(pi: ExtensionAPI, services: CbmServices) {
  let indexInFlight = false;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeSession: IndexSession | undefined;

  async function indexCurrentRepo(session: IndexSession) {
    if (indexInFlight || !session.active || session.signal?.aborted) return;

    indexInFlight = true;
    setCbmStatus(session, "idx");
    try {
      const result = await services.projects.indexCurrentRepo(session.cwd, session.signal);
      if (!session.active || session.signal?.aborted) return;
      setCbmStatus(session, result.status === "indexed" ? "on" : "off");
    } catch {
      if (session.active && !session.signal?.aborted) setCbmStatus(session, "off");
    } finally {
      indexInFlight = false;
    }
  }

  function queueIndex(session: IndexSession) {
    void indexCurrentRepo(session);
  }

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: event.systemPrompt + CODEBASE_MEMORY_PROMPT,
  }));

  pi.on("session_start", (_event, ctx) => {
    services.settings.reload();
    services.stats.startSession(ctx);
    if (activeSession) activeSession.active = false;
    if (refreshTimer) clearInterval(refreshTimer);

    const session: IndexSession = {
      active: true,
      cwd: ctx.cwd,
      signal: ctx.signal,
      ui: ctx.ui,
    };
    activeSession = session;

    queueIndex(session);
    refreshTimer = setInterval(() => {
      queueIndex(session);
    }, AUTO_REFRESH_INTERVAL_MS);
  });

  pi.on("session_shutdown", () => {
    services.stats.endSession();
    if (activeSession) activeSession.active = false;
    activeSession = undefined;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  });

  pi.on("tool_execution_start", async (event) => {
    services.stats.recordToolStart(event.toolCallId, event.toolName, event.args);
  });

  pi.on("tool_execution_end", async (event) => {
    services.stats.recordToolEnd(event.toolCallId, event.isError);
  });

  pi.on("tool_result", async (event, ctx) => {
    const result = await services.augment.augmentResult(event as never, { cwd: ctx.cwd, signal: ctx.signal });
    services.stats.recordAugmentation(result);
    if (result.status !== "matched") return;
    event.content = result.content as never;
  });
}
