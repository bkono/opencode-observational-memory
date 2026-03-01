import { existsSync } from "node:fs";
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin/tool";
import {
  OBSERVATION_CONTEXT_INSTRUCTIONS,
  OBSERVATION_CONTEXT_PROMPT,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { ObservationAgents } from "./agents.js";
import { loadConfig, sessionStatePath } from "./config.js";
import { loadSessionState, saveSessionState } from "./state.js";
import { countMessageTokens, countTokens } from "./tokens.js";
import type { CursorMode, SessionMessage, SessionState } from "./types.js";

type SessionMessagesResult = {
  data?: SessionMessage[];
  error?: unknown;
};

type CycleReason = "idle" | "messages.transform" | "compacting";

type UnobservedWindow = {
  messages: SessionMessage[];
  mode: CursorMode;
};

const DEBUG_ENABLED = process.env.OM_DEBUG === "1";

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  if (details) {
    console.error(`[om][plugin] ${message}`, details);
    return;
  }

  console.error(`[om][plugin] ${message}`);
}

export const ObservationalMemoryPlugin: Plugin = async ({ client, worktree }) => {
  const config = await loadConfig(worktree);
  const agents = new ObservationAgents(config);
  const inflight = new Map<string, Promise<void>>();

  const runObservationCycle = async (
    sessionId: string,
    options?: { forceObserve?: boolean; excludeLatestMessage?: boolean; reason?: CycleReason },
  ): Promise<void> => {
    if (inflight.has(sessionId)) {
      await inflight.get(sessionId);
      return;
    }

    const task = (async () => {
      try {
        const cycleReason = options?.reason ?? "idle";
        const state = await loadSessionState(config.storage.stateDir, sessionId);
        const allMessages = await fetchSessionMessages(sessionId);
        const unobservedWindow = getUnobservedMessages(
          allMessages,
          state.lastObservedMessageId,
          state.lastObservedMessageAt,
        );
        const unobservedMessages = unobservedWindow.messages;
        const cycleBaseState = {
          lastCycleAt: Date.now(),
          lastCycleReason: cycleReason,
          lastCursorMode: unobservedWindow.mode,
        };
        const messagesToObserve = options?.excludeLatestMessage
          ? unobservedMessages.slice(0, -1)
          : unobservedMessages;

        if (messagesToObserve.length === 0) {
          if (cycleReason !== "messages.transform") {
            await saveSessionState(config.storage.stateDir, {
              ...state,
              ...cycleBaseState,
              observeTriggered: false,
              reflectTriggered: false,
            });
          }
          return;
        }

        const unobservedTokens = countMessageTokens(messagesToObserve);
        const shouldObserve =
          options?.forceObserve || unobservedTokens >= config.observation.messageTokens;

        if (!shouldObserve) {
          if (cycleReason !== "messages.transform") {
            await saveSessionState(config.storage.stateDir, {
              ...state,
              ...cycleBaseState,
              observeTriggered: false,
              reflectTriggered: false,
            });
          }
          return;
        }

        const observed = await agents.observe({
          existingObservations: state.observations,
          messages: messagesToObserve,
          customInstruction: config.observation.customInstruction,
        });

        if (!observed.observations.trim()) {
          await saveSessionState(config.storage.stateDir, {
            ...state,
            ...cycleBaseState,
            observeTriggered: true,
            reflectTriggered: false,
          });
          return;
        }

        let observations = appendObservations(state.observations, observed.observations);
        let observationTokens = countTokens(observations);
        let currentTask = observed.currentTask ?? state.currentTask;
        let suggestedResponse = observed.suggestedResponse ?? state.suggestedResponse;
        let reflectTriggered = false;

        if (observationTokens >= config.reflection.observationTokens) {
          reflectTriggered = true;
          const reflected = await agents.reflect({
            observations,
            customInstruction: config.reflection.customInstruction,
          });

          if (reflected.observations.trim()) {
            observations = reflected.observations;
            observationTokens = countTokens(observations);
          }

          if (reflected.currentTask) {
            currentTask = reflected.currentTask;
          }

          if (reflected.suggestedResponse) {
            suggestedResponse = reflected.suggestedResponse;
          }
        }

        const observedBoundary = messagesToObserve.at(-1);
        await saveSessionState(config.storage.stateDir, {
          ...state,
          ...cycleBaseState,
          observations,
          observationTokens,
          lastObservedMessageId: observedBoundary?.info.id ?? state.lastObservedMessageId,
          lastObservedMessageAt: getMessageCreatedAt(observedBoundary) ?? state.lastObservedMessageAt,
          currentTask,
          suggestedResponse,
          observeTriggered: true,
          reflectTriggered,
        });
      } catch (error) {
        debugLog("observation cycle failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    })().finally(() => {
      inflight.delete(sessionId);
    });

    inflight.set(sessionId, task);
    await task;
  };

  const fetchSessionMessages = async (sessionId: string): Promise<SessionMessage[]> => {
    const result = (await client.session.messages({
      path: { id: sessionId },
      query: { directory: worktree },
    })) as SessionMessagesResult;

    if (result.error || !Array.isArray(result.data)) {
      debugLog("session.messages request failed", {
        sessionId,
        hasDataArray: Array.isArray(result.data),
        error: result.error ? String(result.error) : null,
      });
      return [];
    }

    return result.data;
  };

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const sessionId = event.properties.info.id;
        const state = await loadSessionState(config.storage.stateDir, sessionId);
        await saveSessionState(config.storage.stateDir, state);
        return;
      }

      if (event.type === "session.idle") {
        await runObservationCycle(event.properties.sessionID, {
          reason: "idle",
        });
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionId = getSessionIdFromMessages(output.messages);

      if (!sessionId) {
        return;
      }

      const allMessages = [...output.messages];

      await runObservationCycle(sessionId, {
        excludeLatestMessage: true,
        reason: "messages.transform",
      });

      const state = await loadSessionState(config.storage.stateDir, sessionId);
      const unobservedWindow = getUnobservedMessages(
        allMessages,
        state.lastObservedMessageId,
        state.lastObservedMessageAt,
      );

      let boundedMessages = unobservedWindow.messages;
      let cursorMode = unobservedWindow.mode;

      if (boundedMessages.length === 0) {
        const latestMessage = allMessages.at(-1);
        if (latestMessage) {
          boundedMessages = [latestMessage];
          cursorMode = "fallback-latest";
        }
      }

      output.messages.splice(0, output.messages.length, ...boundedMessages);

      await saveSessionState(config.storage.stateDir, {
        ...state,
        lastCycleAt: Date.now(),
        lastCycleReason: "messages.transform",
        lastCursorMode: cursorMode,
        tailMessagesBeforePrune: allMessages.length,
        tailTokensBeforePrune: countMessageTokens(allMessages),
        tailMessagesAfterPrune: boundedMessages.length,
        tailTokensAfterPrune: countMessageTokens(boundedMessages),
        prunedMessagesCount: Math.max(0, allMessages.length - boundedMessages.length),
      });
    },

    "experimental.chat.system.transform": async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId) {
        return;
      }

      const state = await loadSessionState(config.storage.stateDir, sessionId);
      const context = buildObservationContext(state);
      if (!context) {
        return;
      }

      output.system.push(context);
      output.system.push(buildContinuationReminder());
    },

    "experimental.session.compacting": async (input, output) => {
      await runObservationCycle(input.sessionID, {
        forceObserve: true,
        reason: "compacting",
      });

      const state = await loadSessionState(config.storage.stateDir, input.sessionID);
      const context = buildObservationContext(state);
      if (context) {
        output.context.push(context);
      }

      output.context.push(buildContinuationReminder());
    },

    tool: {
      om_status: tool({
        description:
          "Show observational memory status for the current session, including pending token counts.",
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional explicit session ID; defaults to current session."),
        },
        execute: async (args, context) => {
          const sessionId = args.session_id ?? context.sessionID;
          const statePath = sessionStatePath(config.storage.stateDir, sessionId);
          const state = await loadSessionState(config.storage.stateDir, sessionId);
          const messages = await fetchSessionMessages(sessionId);
          const unobservedWindow = getUnobservedMessages(
            messages,
            state.lastObservedMessageId,
            state.lastObservedMessageAt,
          );

          return JSON.stringify(
            {
              sessionId,
              stateDir: config.storage.stateDir,
              statePath,
              stateFileExists: existsSync(statePath),
              observationTokens: state.observationTokens,
              observationThreshold: config.observation.messageTokens,
              reflectionThreshold: config.reflection.observationTokens,
              observationsPresent: Boolean(state.observations.trim()),
              lastObservedMessageId: state.lastObservedMessageId ?? null,
              lastObservedMessageAt:
                typeof state.lastObservedMessageAt === "number"
                  ? new Date(state.lastObservedMessageAt).toISOString()
                  : null,
              cursorModeForCurrentWindow: unobservedWindow.mode,
              unobservedMessages: unobservedWindow.messages.length,
              unobservedMessageTokens: countMessageTokens(unobservedWindow.messages),
              lastCycleAt:
                typeof state.lastCycleAt === "number"
                  ? new Date(state.lastCycleAt).toISOString()
                  : null,
              lastCycleReason: state.lastCycleReason ?? null,
              lastCursorMode: state.lastCursorMode ?? null,
              observeTriggered: state.observeTriggered ?? null,
              reflectTriggered: state.reflectTriggered ?? null,
              tailMessagesBeforePrune: state.tailMessagesBeforePrune ?? null,
              tailTokensBeforePrune: state.tailTokensBeforePrune ?? null,
              tailMessagesAfterPrune: state.tailMessagesAfterPrune ?? null,
              tailTokensAfterPrune: state.tailTokensAfterPrune ?? null,
              prunedMessagesCount: state.prunedMessagesCount ?? null,
              currentTask: state.currentTask ?? null,
              suggestedResponse: state.suggestedResponse ?? null,
              updatedAt: new Date(state.updatedAt).toISOString(),
            },
            null,
            2,
          );
        },
      }),

      om_observations: tool({
        description: "Return the stored observational memory block for a session.",
        args: {
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional explicit session ID; defaults to current session."),
        },
        execute: async (args, context) => {
          const sessionId = args.session_id ?? context.sessionID;
          const state = await loadSessionState(config.storage.stateDir, sessionId);

          if (!state.observations.trim()) {
            return "(no observations stored)";
          }

          const sections = [
            `<session>${sessionId}</session>`,
            "",
            "<observations>",
            state.observations,
            "</observations>",
          ];

          if (state.currentTask) {
            sections.push("", "<current-task>", state.currentTask, "</current-task>");
          }

          if (state.suggestedResponse) {
            sections.push(
              "",
              "<suggested-response>",
              state.suggestedResponse,
              "</suggested-response>",
            );
          }

          return sections.join("\n");
        },
      }),
    },
  };
};

export default ObservationalMemoryPlugin;

function buildObservationContext(state: SessionState): string | undefined {
  if (!state.observations.trim()) {
    return undefined;
  }

  const sections = [
    OBSERVATION_CONTEXT_PROMPT,
    "",
    "<observations>",
    state.observations,
    "</observations>",
  ];

  if (state.currentTask) {
    sections.push("", "<current-task>", state.currentTask, "</current-task>");
  }

  if (state.suggestedResponse) {
    sections.push(
      "",
      "<suggested-response>",
      state.suggestedResponse,
      "</suggested-response>",
    );
  }

  sections.push("", OBSERVATION_CONTEXT_INSTRUCTIONS);

  return sections.join("\n");
}

function buildContinuationReminder(): string {
  return `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`;
}

function appendObservations(existing: string, incoming: string): string {
  const current = normalizeObservations(existing);
  const next = normalizeObservations(incoming);

  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  if (current === next) {
    return current;
  }

  if (next.includes(current)) {
    return next;
  }

  if (current.includes(next)) {
    return current;
  }

  return `${current}\n\n${next}`;
}

function normalizeObservations(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function getUnobservedMessages(
  messages: SessionMessage[],
  lastObservedMessageId?: string,
  lastObservedMessageAt?: number,
): UnobservedWindow {
  if (!lastObservedMessageId && typeof lastObservedMessageAt !== "number") {
    return {
      messages,
      mode: "none",
    };
  }

  if (lastObservedMessageId) {
    const index = messages.findIndex((message) => message.info.id === lastObservedMessageId);
    if (index >= 0) {
      return {
        messages: messages.slice(index + 1),
        mode: "id",
      };
    }
  }

  if (typeof lastObservedMessageAt === "number" && Number.isFinite(lastObservedMessageAt)) {
    const timestampIndex = messages.findIndex((message) => {
      const createdAt = getMessageCreatedAt(message);
      return typeof createdAt === "number" && createdAt > lastObservedMessageAt;
    });

    if (timestampIndex >= 0) {
      return {
        messages: messages.slice(timestampIndex),
        mode: "timestamp",
      };
    }

    const newestCreatedAt = messages.reduce<number | undefined>((latest, message) => {
      const createdAt = getMessageCreatedAt(message);
      if (typeof createdAt !== "number") {
        return latest;
      }
      if (typeof latest !== "number") {
        return createdAt;
      }
      return createdAt > latest ? createdAt : latest;
    }, undefined);

    if (typeof newestCreatedAt === "number" && newestCreatedAt <= lastObservedMessageAt) {
      return {
        messages: [],
        mode: "timestamp",
      };
    }
  }

  const latestMessage = messages.at(-1);
  return {
    messages: latestMessage ? [latestMessage] : [],
    mode: "fallback-latest",
  };
}

function getMessageCreatedAt(message?: SessionMessage): number | undefined {
  if (!message) {
    return undefined;
  }

  const createdAt = message.info.time.created;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return createdAt;
  }

  if (typeof createdAt === "string") {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function getSessionIdFromMessages(messages: SessionMessage[]): string | undefined {
  const latest = messages.at(-1);
  return latest?.info.sessionID;
}
