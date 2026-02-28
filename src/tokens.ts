import { getEncoding } from "js-tiktoken";
import type { SessionMessage } from "./types.js";

const encoding = getEncoding("o200k_base");

export function countTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return encoding.encode(text).length;
}

export function countMessageTokens(messages: SessionMessage[]): number {
  let total = 0;

  for (const message of messages) {
    total += countTokens(serializeMessage(message));
  }

  return total;
}

export function serializeMessage(message: SessionMessage): string {
  const header = [
    `role=${message.info.role}`,
    `message_id=${message.info.id}`,
    `time=${new Date(message.info.time.created).toISOString()}`,
  ].join(" ");

  const body = message.parts
    .map((part) => serializePart(part as Record<string, unknown>))
    .filter(Boolean)
    .join("\n");

  return `${header}\n${body}`;
}

function serializePart(part: Record<string, unknown>): string {
  const type = typeof part.type === "string" ? part.type : "unknown";

  switch (type) {
    case "text":
    case "reasoning":
      return `part:${type} ${asString(part.text) ?? ""}`;
    case "tool":
      return [
        `part:tool name=${asString(part.tool) ?? "unknown"}`,
        `status=${asString((part.state as Record<string, unknown> | undefined)?.status) ?? "unknown"}`,
        `input=${safeJson((part.state as Record<string, unknown> | undefined)?.input)}`,
        `output=${asString((part.state as Record<string, unknown> | undefined)?.output) ?? ""}`,
        `error=${asString((part.state as Record<string, unknown> | undefined)?.error) ?? ""}`,
      ].join(" ");
    case "file":
      return [
        `part:file name=${asString(part.filename) ?? ""}`,
        `url=${asString(part.url) ?? ""}`,
      ].join(" ");
    case "subtask":
      return [
        `part:subtask agent=${asString(part.agent) ?? ""}`,
        `description=${asString(part.description) ?? ""}`,
        `prompt=${asString(part.prompt) ?? ""}`,
      ].join(" ");
    case "step-finish":
      return `part:step-finish reason=${asString(part.reason) ?? ""}`;
    case "patch":
      return `part:patch files=${safeJson(part.files)}`;
    case "agent":
      return `part:agent name=${asString(part.name) ?? ""}`;
    case "retry":
      return `part:retry attempt=${asNumber(part.attempt) ?? 0} error=${safeJson(part.error)}`;
    case "compaction":
      return `part:compaction auto=${String(part.auto)}`;
    default:
      return `part:${type}`;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function safeJson(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
