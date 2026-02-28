import OpenAI from "openai";
import { serializeMessage } from "./tokens.js";
import type { OMConfig, ObserverResult, SessionMessage } from "./types.js";

const OBSERVER_PROMPT = `You are the Observer for an append-log observational memory system.

Convert the provided conversation slice into dense event observations.

Rules:
1) Output MUST use this exact structure:
Date: YYYY-MM-DD
- 🔴 HH:MM <critical observation>
- 🟡 HH:MM <important observation>
- 🟢 HH:MM <minor observation>

Current task: <what the assistant is currently working on>
Suggested response: <how the assistant should continue in the next turn>

2) Observations must be factual, concrete, and operationally useful.
3) Preserve decisions, constraints, rejected approaches, and invariants.
4) Keep event-log style bullets, never prose paragraphs.
5) Prefer concise bullets with high information density.`;

const REFLECTOR_PROMPT = `You are the Reflector for an append-log observational memory system.

You will receive the full observation log. Reorganize it into a tighter, de-duplicated event log while preserving all critical information.

Rules:
1) Preserve event-log structure and priority tags (🔴 🟡 🟢).
2) Merge related observations and drop superseded/redundant details.
3) Keep explicit decisions, constraints, and current trajectory.
4) Do NOT convert to prose summary.
5) Preserve date headers and timeline semantics.

Output only the updated observation log.`;

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

  async observe(messages: SessionMessage[]): Promise<ObserverResult> {
    const conversation = messages.map(serializeMessage).join("\n\n");
    const raw = await this.complete({
      model: this.config.observation.model,
      systemPrompt: OBSERVER_PROMPT,
      userPrompt: `Conversation slice:\n\n${conversation}`,
    });

    return parseObserverOutput(raw);
  }

  async reflect(observations: string): Promise<string> {
    const raw = await this.complete({
      model: this.config.reflection.model,
      systemPrompt: REFLECTOR_PROMPT,
      userPrompt: `Observation log:\n\n${observations}`,
    });

    return raw.trim();
  }

  private async complete(input: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: input.model,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: input.systemPrompt,
        },
        {
          role: "user",
          content: input.userPrompt,
        },
      ],
    });

    return response.choices[0]?.message?.content?.trim() ?? "";
  }
}

export function parseObserverOutput(raw: string): ObserverResult {
  const normalized = raw.trim();

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
