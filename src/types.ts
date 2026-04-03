import type { Message, Part } from "@opencode-ai/sdk";

export interface OMConfig {
  agents: string[] | "all";
  observation: {
    messageTokens: number;
    model: string;
    customInstruction?: string;
  };
  reflection: {
    observationTokens: number;
    model: string;
    customInstruction?: string;
  };
  api: {
    baseURL?: string;
    apiKey?: string;
  };
  storage: {
    stateDir: string;
  };
}

export type CursorMode = "none" | "id" | "timestamp" | "fallback-latest";

export interface SessionState {
  sessionId: string;
  observations: string;
  observationTokens: number;
  lastObservedMessageId?: string;
  lastObservedMessageAt?: number;
  currentTask?: string;
  suggestedResponse?: string;
  lastCycleAt?: number;
  lastCycleReason?: string;
  lastCursorMode?: CursorMode;
  tailMessagesBeforePrune?: number;
  tailTokensBeforePrune?: number;
  tailMessagesAfterPrune?: number;
  tailTokensAfterPrune?: number;
  observeTriggered?: boolean;
  reflectTriggered?: boolean;
  prunedMessagesCount?: number;
  updatedAt: number;
}

export interface ObserverResult {
  observations: string;
  currentTask?: string;
  suggestedResponse?: string;
  raw: string;
}

export type SessionMessage = {
  info: Message;
  parts: Part[];
};
