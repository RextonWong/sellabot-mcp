/**
 * Shared agent runtime — the tool-use loop used by all three agents.
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
  /** Preserve Gemini model parts verbatim, including opaque thought signatures. */
  geminiParts?: GeminiPart[];
}

export type AgentProvider = "anthropic" | "gemini";

interface AnthropicResponse {
  stop_reason: "end_turn" | "tool_use" | string;
  content: ContentBlock[];
  geminiParts?: GeminiPart[];
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
  provider: AgentProvider;
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

interface GeminiPart {
  thoughtSignature?: string;
  thought?: boolean;
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  error?: { message?: string };
}

function toGeminiTools(tools: readonly unknown[]): Array<{ functionDeclarations: unknown[] }> {
  return [{
    functionDeclarations: tools.map((tool) => {
      const definition = tool as {
        name: string;
        description?: string;
        input_schema?: unknown;
      };
      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.input_schema ?? { type: "object", properties: {} },
      };
    }),
  }];
}

function toGeminiContents(messages: Message[]): Array<{ role: "user" | "model"; parts: GeminiPart[] }> {
  const toolNames = new Map<string, string>();
  const syntheticIds = new Set<string>();

  return messages.map((message) => {
    if (message.role === "assistant" && message.geminiParts) {
      const calls = Array.isArray(message.content)
        ? (message.content as ContentBlock[]).filter((block): block is ToolUseBlock => block.type === "tool_use")
        : [];
      let callIndex = 0;
      for (const part of message.geminiParts) {
        if (part.functionCall) {
          const id = part.functionCall.id ?? calls[callIndex]?.id;
          if (id) {
            toolNames.set(id, part.functionCall.name);
            if (!part.functionCall.id) syntheticIds.add(id);
          }
          callIndex++;
        }
      }
      return { role: "model", parts: message.geminiParts };
    }
    if (typeof message.content === "string") {
      return { role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] };
    }

    const blocks = Array.isArray(message.content) ? message.content : [];
    const parts: GeminiPart[] = [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ text: block.text });
      } else if (block.type === "image") {
        const source = block.source as { type?: string; media_type?: string; data?: string } | undefined;
        if (source?.type === "base64" && source.data) {
          parts.push({ inlineData: { mimeType: source.media_type ?? "image/jpeg", data: source.data } });
        }
      } else if (block.type === "tool_use") {
        const id = typeof block.id === "string" ? block.id : crypto.randomUUID();
        const name = String(block.name ?? "");
        toolNames.set(id, name);
        parts.push({
          functionCall: {
            id,
            name,
            args: (block.input as Record<string, unknown>) ?? {},
          },
        });
      } else if (block.type === "tool_result") {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
        const name = id ? toolNames.get(id) : undefined;
        if (id && name) {
          parts.push({
            functionResponse: {
              ...(syntheticIds.has(id) ? {} : { id }),
              name,
              response: { result: String(block.content ?? "") },
            },
          });
        }
      }
    }
    return { role: message.role === "assistant" ? "model" : "user", parts };
  });
}

async function callGemini(deps: LoopDeps, messages: Message[]): Promise<AnthropicResponse> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(deps.model)}:generateContent`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": deps.apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: deps.system }] },
      contents: toGeminiContents(messages),
      tools: toGeminiTools(deps.tools),
      generationConfig: { maxOutputTokens: deps.maxTokens ?? 1024 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }

  const data = await res.json() as GeminiResponse;
  if (data.error?.message) throw new Error(`Gemini API error: ${data.error.message}`);
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content: ContentBlock[] = parts.flatMap<ContentBlock>((part) => {
    if (part.thought) return [];
    if (part.text) return [{ type: "text" as const, text: part.text }];
    if (part.functionCall) {
      return [{
        type: "tool_use" as const,
        id: part.functionCall.id ?? crypto.randomUUID(),
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      }];
    }
    return [];
  });

  return {
    stop_reason: content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
    content,
    geminiParts: parts,
  };
}

function callModel(deps: LoopDeps, messages: Message[]): Promise<AnthropicResponse> {
  return deps.provider === "gemini" ? callGemini(deps, messages) : callClaude(deps, messages);
}

/**
 * Runs the agentic loop against `history` (mutated in place), executing tools
 * until Claude stops calling them. Returns the final assistant text.
 */
export async function runAgentLoop(deps: LoopDeps, history: Message[]): Promise<string> {
  let response = await callModel(deps, history);
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

    history.push({ role: "assistant", content: response.content,
      ...(response.geminiParts ? { geminiParts: response.geminiParts } : {}),
    });
    history.push({ role: "user", content: toolResults });
    response = await callModel(deps, history);
  }

  const text = response.content
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  history.push({ role: "assistant", content: text,
    ...(response.geminiParts ? { geminiParts: response.geminiParts } : {}),
  });
  return text || "Done.";
}
