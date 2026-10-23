import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import { AGENT_MODEL, ANSWER_MODEL, CHAT_MODEL } from "../constants/models";
import { openai } from "../infra/openai/client";
import type * as Port from "../core/ports";
import { createLogInspectionTool } from "./log-inspection-tool";

export const ANSWER_INSTRUCTIONS =
  "Answer using only the retrieved context. If the context does not contain the answer, say so.";

export function createInspectorAgent(
  journal: Port.Journal,
  model: MastraModelConfig = openai(AGENT_MODEL),
) {
  return new Agent({
    id: "inspector",
    name: "inspector",
    instructions:
      "Examine the provided asset, evaluate its condition, and log the record using the logInspection tool.",
    model,
    tools: { logInspection: createLogInspectionTool(journal) },
  });
}

export function createAnswererAgent(
  model: MastraModelConfig = openai(ANSWER_MODEL),
) {
  return new Agent({
    id: "answerer",
    name: "answerer",
    instructions: ANSWER_INSTRUCTIONS,
    model,
  });
}

/** The chat prompt is supplied per call (frozen system text), so the agent carries no fixed instructions. */
export function createChatAgent(model: MastraModelConfig = openai(CHAT_MODEL)) {
  return new Agent({ id: "chat", name: "chat", instructions: "Follow the instructions given with each request.", model });
}

export function createSummarizerAgent(model: MastraModelConfig = openai(CHAT_MODEL)) {
  return new Agent({
    id: "chat-summarizer",
    name: "chat-summarizer",
    instructions: "You compress chat history into the exact section template you are given.",
    model,
  });
}
