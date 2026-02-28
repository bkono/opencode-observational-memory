import type { Message, Part } from "@opencode-ai/sdk";

export interface OMConfig {
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

export interface SessionState {
  sessionId: string;
  observations: string;
  observationTokens: number;
  lastObservedMessageId?: string;
  currentTask?: string;
  suggestedResponse?: string;
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
