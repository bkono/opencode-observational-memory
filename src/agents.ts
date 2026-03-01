import OpenAI from "openai";
import {
  buildObserverSystemPrompt,
  buildReflectorSystemPrompt,
  OBSERVATION_CONTINUATION_HINT,
} from "./prompts.js";
import { serializeMessage } from "./tokens.js";
import type { OMConfig, ObserverResult, SessionMessage } from "./types.js";

const DEBUG_ENABLED = process.env.OM_DEBUG === "1";

function debugLog(message: string, details?: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) {
    return;
  }

  if (details) {
    console.error(`[om][agents] ${message}`, details);
    return;
  }

  console.error(`[om][agents] ${message}`);
}

export class ObservationAgents {
  private readonly client: OpenAI;

  constructor(private readonly config: OMConfig) {
    if (!config.api.apiKey) {
      throw new Error(
        "Observational memory requires an API key. Set OM_API_KEY, OPENAI_API_KEY, or api.apiKey in om-config.json.",
      );
    }

    this.client = new OpenAI({
      apiKey: config.api.apiKey,
      baseURL: config.api.baseURL,
    });
  }

  async observe(input: {
    existingObservations: string;
    messages: SessionMessage[];
    customInstruction?: string;
    includeContinuationHint?: boolean;
  }): Promise<ObserverResult> {
    const conversation = input.messages.map(serializeMessage).join("\n\n");
    const systemPrompt = buildObserverSystemPrompt(
      input.customInstruction ?? this.config.observation.customInstruction,
    );

    const previousObservations = input.existingObservations.trim();
    const userPromptSections: string[] = [];

    if (previousObservations) {
      userPromptSections.push(
        "## Previous Observations",
        "",
        previousObservations,
        "",
        "---",
        "",
        "Do not repeat these existing observations. Your new observations will be appended to the existing observations.",
        "",
      );
    }

    userPromptSections.push(
      "## New Message History to Observe",
      "",
      conversation,
      "",
      "---",
      "",
      "## Your Task",
      "",
      "Extract new observations from the message history above. Do not repeat observations that are already in the previous observations. Add your new observations in the format specified in your instructions.",
    );

    if (input.includeContinuationHint) {
      userPromptSections.push(
        "",
        `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
      );
    }

    const userPrompt = userPromptSections.join("\n");

    const raw = await this.complete({
      model: this.config.observation.model,
      systemPrompt,
      userPrompt,
    });

    return parseObserverOutput(raw);
  }

  async reflect(input: {
    observations: string;
    customInstruction?: string;
  }): Promise<ObserverResult> {
    const raw = await this.complete({
      model: this.config.reflection.model,
      systemPrompt: buildReflectorSystemPrompt(
        input.customInstruction ?? this.config.reflection.customInstruction,
      ),
      userPrompt: `Current observations:\n\n${input.observations}`,
    });

    return parseObserverOutput(raw);
  }

  private async complete(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: input.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      });

      const content = response.choices[0]?.message?.content?.trim() ?? "";
      return content;
    } catch (error) {
      debugLog("completion failed", {
        model: input.model,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

function extractXmlTag(raw: string, tag: string): string | undefined {
  const match = raw.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1]?.trim();
}

export function parseObserverOutput(raw: string): ObserverResult {
  const normalized = raw.trim();

  const observationsTag = extractXmlTag(normalized, "observations");
  const currentTaskTag = extractXmlTag(normalized, "current-task");
  const suggestedTag = extractXmlTag(normalized, "suggested-response");

  if (observationsTag || currentTaskTag || suggestedTag) {
    return {
      observations: observationsTag ?? normalized,
      currentTask: currentTaskTag,
      suggestedResponse: suggestedTag,
      raw: normalized,
    };
  }

  const currentTaskMatch = normalized.match(/(?:^|\n)Current task:\s*(.+)$/im);
  const suggestedMatch = normalized.match(/(?:^|\n)Suggested response:\s*(.+)$/im);

  let observations = normalized;

  const cutoffIndices = [currentTaskMatch?.index, suggestedMatch?.index]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);

  if (cutoffIndices.length > 0) {
    observations = normalized.slice(0, cutoffIndices[0]).trim();
  }

  return {
    observations,
    currentTask: currentTaskMatch?.[1]?.trim(),
    suggestedResponse: suggestedMatch?.[1]?.trim(),
    raw: normalized,
  };
}
