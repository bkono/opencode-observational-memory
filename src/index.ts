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
import type { SessionMessage, SessionState } from "./types.js";

type SessionMessagesResult = {
  data?: SessionMessage[];
  error?: unknown;
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
    options?: { forceObserve?: boolean },
  ): Promise<void> => {
    if (inflight.has(sessionId)) {
      await inflight.get(sessionId);
      return;
    }

    const task = (async () => {
      try {
        const state = await loadSessionState(config.storage.stateDir, sessionId);
        const allMessages = await fetchSessionMessages(sessionId);
        const unobservedMessages = getUnobservedMessages(allMessages, state.lastObservedMessageId);

        if (unobservedMessages.length === 0) {
          return;
        }

        const unobservedTokens = countMessageTokens(unobservedMessages);
        const shouldObserve =
          options?.forceObserve || unobservedTokens >= config.observation.messageTokens;

        if (!shouldObserve) {
          return;
        }

        const observed = await agents.observe({
          existingObservations: state.observations,
          messages: unobservedMessages,
          customInstruction: config.observation.customInstruction,
        });

        if (!observed.observations.trim()) {
          return;
        }

        let observations = appendObservations(state.observations, observed.observations);
        let observationTokens = countTokens(observations);
        let currentTask = observed.currentTask ?? state.currentTask;
        let suggestedResponse = observed.suggestedResponse ?? state.suggestedResponse;

        if (observationTokens >= config.reflection.observationTokens) {
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

        await saveSessionState(config.storage.stateDir, {
          ...state,
          observations,
          observationTokens,
          lastObservedMessageId: unobservedMessages.at(-1)?.info.id,
          currentTask,
          suggestedResponse,
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
        await runObservationCycle(event.properties.sessionID);
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const sessionId = getSessionIdFromMessages(output.messages);

      if (!sessionId) {
        return;
      }

      await runObservationCycle(sessionId);
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
    },

    "experimental.session.compacting": async (input, output) => {
      await runObservationCycle(input.sessionID, {
        forceObserve: true,
      });

      const state = await loadSessionState(config.storage.stateDir, input.sessionID);
      const context = buildObservationContext(state);
      if (context) {
        output.context.push(context);
      }

      output.context.push(OBSERVATION_CONTINUATION_HINT);
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
          const unobserved = getUnobservedMessages(messages, state.lastObservedMessageId);

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
              unobservedMessages: unobserved.length,
              unobservedMessageTokens: countMessageTokens(unobserved),
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

function appendObservations(existing: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) {
    return existing;
  }

  const current = existing.trim();
  if (!current) {
    return next;
  }

  return `${current}\n\n${next}`;
}

function getUnobservedMessages(
  messages: SessionMessage[],
  lastObservedMessageId?: string,
): SessionMessage[] {
  if (!lastObservedMessageId) {
    return messages;
  }

  const index = messages.findIndex((message) => message.info.id === lastObservedMessageId);

  if (index < 0) {
    return messages;
  }

  return messages.slice(index + 1);
}

function getSessionIdFromMessages(messages: SessionMessage[]): string | undefined {
  const latest = messages.at(-1);
  return latest?.info.sessionID;
}
