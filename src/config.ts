import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OMConfig } from "./types.js";

const DEFAULTS = {
  observation: {
    messageTokens: 30_000,
    model: "google/gemini-2.5-flash",
  },
  reflection: {
    observationTokens: 40_000,
    model: "google/gemini-2.5-flash",
  },
} as const;

interface PartialConfig {
  observation?: {
    messageTokens?: unknown;
    model?: unknown;
    customInstruction?: unknown;
  };
  reflection?: {
    observationTokens?: unknown;
    model?: unknown;
    customInstruction?: unknown;
  };
  api?: {
    baseURL?: unknown;
    apiKey?: unknown;
  };
  storage?: {
    stateDir?: unknown;
  };
}

export async function loadConfig(worktree: string): Promise<OMConfig> {
  const globalPath = join(homedir(), ".config", "opencode", "om-config.json");
  const projectPath = join(worktree, ".opencode", "om-config.json");

  const globalConfig = await readConfigFile(globalPath);
  const projectConfig = await readConfigFile(projectPath);
  const merged = mergeConfig(globalConfig, projectConfig);

  const stateDir =
    asString(merged.storage?.stateDir) ?? join(worktree, ".opencode", "om-state");

  await mkdir(stateDir, { recursive: true });

  return {
    observation: {
      messageTokens:
        asPositiveInteger(merged.observation?.messageTokens) ??
        DEFAULTS.observation.messageTokens,
      model: asString(merged.observation?.model) ?? DEFAULTS.observation.model,
      customInstruction: asString(merged.observation?.customInstruction),
    },
    reflection: {
      observationTokens:
        asPositiveInteger(merged.reflection?.observationTokens) ??
        DEFAULTS.reflection.observationTokens,
      model: asString(merged.reflection?.model) ?? DEFAULTS.reflection.model,
      customInstruction: asString(merged.reflection?.customInstruction),
    },
    api: {
      baseURL: asString(merged.api?.baseURL) ?? process.env.OM_API_BASE_URL,
      apiKey:
        asString(merged.api?.apiKey) ??
        process.env.OM_API_KEY ??
        process.env.OPENAI_API_KEY,
    },
    storage: {
      stateDir,
    },
  };
}

async function readConfigFile(path: string): Promise<PartialConfig> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return (typeof parsed === "object" && parsed ? parsed : {}) as PartialConfig;
  } catch {
    return {};
  }
}

function mergeConfig(base: PartialConfig, override: PartialConfig): PartialConfig {
  return {
    observation: {
      ...base.observation,
      ...override.observation,
    },
    reflection: {
      ...base.reflection,
      ...override.reflection,
    },
    api: {
      ...base.api,
      ...override.api,
    },
    storage: {
      ...base.storage,
      ...override.storage,
    },
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function sessionStatePath(stateDir: string, sessionId: string): string {
  return join(stateDir, `${sessionId}.json`);
}

export async function ensureParentDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}
