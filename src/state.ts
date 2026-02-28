import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { ensureParentDirectory, sessionStatePath } from "./config.js";
import type { SessionState } from "./types.js";

const DEBUG_ENABLED = process.env.OM_DEBUG === "1";

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  if (details) {
    console.error(`[om][state] ${message}`, details);
    return;
  }

  console.error(`[om][state] ${message}`);
}

export function createDefaultState(sessionId: string): SessionState {
  return {
    sessionId,
    observations: "",
    observationTokens: 0,
    updatedAt: Date.now(),
  };
}

export async function loadSessionState(
  stateDir: string,
  sessionId: string,
): Promise<SessionState> {
  const path = sessionStatePath(stateDir, sessionId);

  if (!existsSync(path)) {
    return createDefaultState(sessionId);
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SessionState>;
    const nextState = {
      sessionId,
      observations: typeof parsed.observations === "string" ? parsed.observations : "",
      observationTokens:
        typeof parsed.observationTokens === "number" && parsed.observationTokens >= 0
          ? parsed.observationTokens
          : 0,
      lastObservedMessageId:
        typeof parsed.lastObservedMessageId === "string"
          ? parsed.lastObservedMessageId
          : undefined,
      currentTask:
        typeof parsed.currentTask === "string" ? parsed.currentTask : undefined,
      suggestedResponse:
        typeof parsed.suggestedResponse === "string"
          ? parsed.suggestedResponse
          : undefined,
      updatedAt:
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : Date.now(),
    };

    return nextState;
  } catch (error) {
    debugLog("state load failed; returning default", {
      sessionId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });

    return createDefaultState(sessionId);
  }
}

export async function saveSessionState(
  stateDir: string,
  state: SessionState,
): Promise<void> {
  const path = sessionStatePath(stateDir, state.sessionId);
  await ensureParentDirectory(path);

  const persistedState = {
    ...state,
    updatedAt: Date.now(),
  };

  await writeFile(path, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
}
