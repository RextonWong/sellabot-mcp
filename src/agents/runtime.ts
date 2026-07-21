/**
 * Shared agent runtime — the Claude tool-use loop used by all three agents
 * (Manager, Operating, Promoting) plus a shared activity tracker.
 *
 * Each agent owns its own conversation history and tool set; this module holds
 * the plumbing they share: calling the Anthropic API and looping over tool_use.
 */
import { logger } from "../core/logger.js";

// ── Message / content block types ──────────────────────────────────────────────

export interface TextBlock { type: "text"; text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export type ContentBlock = TextBlock | ToolUseBlock;

/** A conversation message. Content is intentionally loose to allow multimodal + tool_result blocks. */
export interface Message {
  role: "user" | "assistant";
  content: unknown;
}

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | string;
  content: ContentBlock[];
}

// ── Activity tracking (feeds Telegram /activity) ───────────────────────────────

export type AgentName = "manager" | "operating" | "promoting";

export interface ActivityEntry {
  ts: string;
  agent: AgentName;
  tool: string;
  summary: string;
}

export class ActivityTracker {
  readonly entries: ActivityEntry[] = [];
  private readonly max = 60;

  record(agent: AgentName, tool: string, result: string): void {
    const summary = (result.split("\n")[0] ?? "").slice(0, 120);
    this.entries.unshift({ ts: new Date().toISOString(), agent, tool, summary });
    if (this.entries.length > this.max) this.entries.length = this.max;
  }
}

// ── The loop ───────────────────────────────────────────────────────────────────

export interface LoopDeps {
  apiKey: string;
  model: string;
  system: string;
  tools: readonly unknown[];
  maxTokens?: number;
  maxIterations?: number;
  /** Runs one tool call and returns its textual result. */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Called after each tool runs — used to record activity. */
  onTool?: (name: string, input: Record<string, unknown>, result: string) => void;
  /** Log prefix, e.g. "operating agent". */
  label: string;
}

async function callClaude(deps: LoopDeps, messages: Message[]): Promise<AnthropicResponse> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": deps.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: deps.model,
      max_tokens: deps.maxTokens ?? 1024,
      system: deps.system,
      tools: deps.tools,
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  return res.json() as Promise<AnthropicResponse>;
}

/**
 * Runs the agentic loop against `history` (mutated in place), executing tools
 * until Claude stops calling them. Returns the final assistant text.
 */
export async function runAgentLoop(deps: LoopDeps, history: Message[]): Promise<string> {
  let response = await callClaude(deps, history);
  let iterations = 0;
  const maxIterations = deps.maxIterations ?? 6;

  while (response.stop_reason === "tool_use" && iterations < maxIterations) {
    iterations++;
    const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];

    for (const toolUse of toolUses) {
      logger.info(`${deps.label}: tool call`, { tool: toolUse.name, input: toolUse.input });
      let result: string;
      try {
        result = await deps.executeTool(toolUse.name, toolUse.input);
        logger.info(`${deps.label}: tool result`, { tool: toolUse.name, result: result.slice(0, 300) });
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        logger.error(`${deps.label}: tool threw`, { tool: toolUse.name, error: (err as Error).message });
      }
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
      deps.onTool?.(toolUse.name, toolUse.input, result);
    }

    history.push({ role: "assistant", content: response.content });
    history.push({ role: "user", content: toolResults });
    response = await callClaude(deps, history);
  }

  const text = response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  history.push({ role: "assistant", content: text });
  return text || "Done.";
}
