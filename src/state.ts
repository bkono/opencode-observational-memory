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
      lastObservedMessageAt:
        typeof parsed.lastObservedMessageAt === "number" && Number.isFinite(parsed.lastObservedMessageAt)
          ? parsed.lastObservedMessageAt
          : undefined,
      currentTask:
        typeof parsed.currentTask === "string" ? parsed.currentTask : undefined,
      suggestedResponse:
        typeof parsed.suggestedResponse === "string"
          ? parsed.suggestedResponse
          : undefined,
      lastCycleAt:
        typeof parsed.lastCycleAt === "number" && Number.isFinite(parsed.lastCycleAt)
          ? parsed.lastCycleAt
          : undefined,
      lastCycleReason:
        typeof parsed.lastCycleReason === "string" ? parsed.lastCycleReason : undefined,
      lastCursorMode:
        parsed.lastCursorMode === "none" ||
        parsed.lastCursorMode === "id" ||
        parsed.lastCursorMode === "timestamp" ||
        parsed.lastCursorMode === "fallback-latest"
          ? parsed.lastCursorMode
          : undefined,
      tailMessagesBeforePrune:
        typeof parsed.tailMessagesBeforePrune === "number" &&
        Number.isFinite(parsed.tailMessagesBeforePrune)
          ? parsed.tailMessagesBeforePrune
          : undefined,
      tailTokensBeforePrune:
        typeof parsed.tailTokensBeforePrune === "number" && Number.isFinite(parsed.tailTokensBeforePrune)
          ? parsed.tailTokensBeforePrune
          : undefined,
      tailMessagesAfterPrune:
        typeof parsed.tailMessagesAfterPrune === "number" &&
        Number.isFinite(parsed.tailMessagesAfterPrune)
          ? parsed.tailMessagesAfterPrune
          : undefined,
      tailTokensAfterPrune:
        typeof parsed.tailTokensAfterPrune === "number" && Number.isFinite(parsed.tailTokensAfterPrune)
          ? parsed.tailTokensAfterPrune
          : undefined,
      observeTriggered:
        typeof parsed.observeTriggered === "boolean" ? parsed.observeTriggered : undefined,
      reflectTriggered:
        typeof parsed.reflectTriggered === "boolean" ? parsed.reflectTriggered : undefined,
      prunedMessagesCount:
        typeof parsed.prunedMessagesCount === "number" && Number.isFinite(parsed.prunedMessagesCount)
          ? parsed.prunedMessagesCount
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
