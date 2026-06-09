// AI service for OpenSCAD Playground using Vercel AI SDK
// Supports: Anthropic and OpenAI (including custom OpenAI-compatible endpoints via Base URL)
// Uses a multi-step agent loop with tool calling for code editing

import { createAnthropic, anthropic as defaultAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, ModelMessage, stepCountIs } from 'ai';
import { createAgentTools, ToolCallRecord, ToolContext, MessagePart } from './tools';

// ---- Provider Config ----

export type ProviderType = 'anthropic' | 'openai';

export interface StoredConfig {
  type: ProviderType;
  apiKey: string;
  baseURL?: string;        // Custom endpoint URL
  model: string;           // Model ID string
}

export const DEFAULT_CONFIGS: Record<ProviderType, Omit<StoredConfig, 'apiKey'>> = {
  anthropic: {
    type: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  openai: {
    type: 'openai',
    model: 'gpt-4o',
  },
};

// ---- localStorage key management ----

const STORAGE_KEY = 'openscad-ai-config';

export function getStoredConfig(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredConfig(config: StoredConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearStoredConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function hasStoredConfig(): boolean {
  const c = getStoredConfig();
  return c !== null && c.apiKey.trim().length > 0;
}

// ---- System Prompt ----

export const SYSTEM_PROMPT = `You are an expert OpenSCAD coding assistant with the ability to directly read and edit code in the user's editor.

You have deep knowledge of:
- OpenSCAD language syntax and semantics
- All built-in modules: cube(), sphere(), cylinder(), polyhedron(), linear_extrude(), rotate_extrude(), translate(), rotate(), scale(), union(), difference(), intersection(), hull(), minkowski(), etc.
- $fa, $fs, $fn special variables for controlling smoothness
- The BOSL2, MCAD, and other popular OpenSCAD libraries
- CSG (Constructive Solid Geometry) principles
- Best practices for parametric design in OpenSCAD

## How You Edit Code

You have THREE tools available to interact with the editor:

1. **read_code** — Read the current editor content. ALWAYS call this FIRST before making any edits.
2. **edit_code** — Replace a specific section of code using exact string matching. Provide old_string (exact copy from the file) and new_string (replacement). Use this for targeted changes.
3. **write_code** — Replace ALL code in the editor. Use for creating new designs from scratch.

## Workflow

When the user asks you to create or modify a design, follow this workflow:

1. **Read** the current code with read_code (unless the file is empty / creating from scratch)
2. **Plan** your changes and explain what you'll do
3. **Edit** the code:
   - For targeted changes: use edit_code one or more times (preferred — it's more surgical)
   - For new designs: use write_code to write the complete code
4. **Verify** by calling read_code to confirm your changes look correct
5. **Summarize** what you changed

## Edit Rules

- For edit_code: the old_string MUST match the file EXACTLY — including spaces, indentation, line breaks. Copy from read_code output verbatim.
- Include enough surrounding context in old_string to make it unique (2-3 lines above and below the change).
- Prefer edit_code over write_code for modifications — it preserves the rest of the user's code.
- Write clean, well-commented OpenSCAD code with descriptive variable names.
- Respect parametric design principles — use variables for key dimensions.

Never generate code that is harmful or malicious.`;

// ---- Chat types ----

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
  parts?: MessagePart[];  // ordered text + tool call interleaving
  reasoning?: string;
}

// ---- Agent stream event types ----

export interface AgentEventTextDelta { type: 'text-delta'; text: string }
export interface AgentEventReasoningDelta { type: 'reasoning-delta'; text: string }
export interface AgentEventToolCallStart { type: 'tool-call-start'; toolCallId: string; toolName: string }
export interface AgentEventToolCallArgs { type: 'tool-call-args'; toolCallId: string; delta: string }
export interface AgentEventToolCallEnd { type: 'tool-call-end'; toolCallId: string; toolName: string; input: Record<string, unknown> }
export interface AgentEventToolResult { type: 'tool-result'; toolCallId: string; toolName: string; output: string; success: boolean }
export interface AgentEventStepFinish { type: 'step-finish'; stepNumber: number }
export interface AgentEventDone { type: 'done'; fullText: string; toolCalls: ToolCallRecord[]; reasoning: string }
export interface AgentEventError { type: 'error'; error: string }
export type AgentStreamEvent =
  | AgentEventTextDelta
  | AgentEventReasoningDelta
  | AgentEventToolCallStart
  | AgentEventToolCallArgs
  | AgentEventToolCallEnd
  | AgentEventToolResult
  | AgentEventStepFinish
  | AgentEventDone
  | AgentEventError;

// ---- Streaming chat using AI SDK streamText with tools ----

export async function* streamChat(
  messages: { role: 'user' | 'assistant'; content: string }[],
  codeRef: { current: string },
  onCodeChange: (newCode: string) => void,
  activePath: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const config = getStoredConfig();
  if (!config) {
    yield { type: 'error', error: 'No API configuration found. Please configure your API key in Settings.' };
    return;
  }

  // Create tool context linked to the mutable code reference
  const toolCtx: ToolContext = {
    getCode: () => codeRef.current,
    setCode: (code: string) => {
      codeRef.current = code;
      onCodeChange(code);
    },
    getActivePath: () => activePath,
  };

  const tools = createAgentTools(toolCtx);

  // Build message array for AI SDK
  const aiMessages: ModelMessage[] = [];

  // Add current code context as system-level info if there's code
  const currentCode = codeRef.current.trim();
  if (currentCode) {
    aiMessages.push({
      role: 'user',
      content: `My current OpenSCAD code is in the editor (file: "${activePath}"). Use read_code to see it before making changes:\n\n\`\`\`openscad\n${currentCode}\n\`\`\``,
    });
  }

  // Add conversation messages
  for (const m of messages) {
    aiMessages.push({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    });
  }

  try {
    // Create the AI SDK model based on provider config
    let model;
    const { type, apiKey, baseURL, model: modelId } = config;

    switch (type) {
      case 'anthropic': {
        if (baseURL) {
          const provider = createAnthropic({ apiKey, baseURL });
          model = provider(modelId);
        } else {
          model = defaultAnthropic(modelId);
        }
        break;
      }
      case 'openai': {
        const provider = createOpenAI({
          apiKey,
          baseURL: baseURL || undefined,
        });
        model = provider.chat(modelId);
        break;
      }
      default:
        yield { type: 'error', error: `Unsupported provider type: ${type}` };
        return;
    }

    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      messages: aiMessages,
      tools,
      stopWhen: stepCountIs(8), // Allow up to 8 LLM steps (read + multiple edits + verify)
      abortSignal,
      includeRawChunks: true,
    });

    let fullText = '';
    let fullReasoning = '';
    let stepNumber = 0;
    const toolCallRecords: ToolCallRecord[] = [];

    // Track per-tool-call state
    const toolNameMap = new Map<string, string>(); // toolCallId → toolName
    const toolArgsBuf = new Map<string, string>(); // toolCallId → accumulated args JSON

    // Helper to extract reasoning_content from raw DeepSeek chunks
    const tryExtractReasoning = (rawData: unknown) => {
      try {
        const obj = rawData as any;
        const choices = obj?.choices;
        if (choices && Array.isArray(choices)) {
          for (const choice of choices) {
            const rc = choice?.delta?.reasoning_content;
            if (typeof rc === 'string' && rc.length > 0) {
              return rc;
            }
          }
        }
      } catch { /* ignore parse errors */ }
      return null;
    };

    // Consume the fullStream for interleaved text + tool calls
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'raw': {
          // Check for reasoning_content from DeepSeek-style APIs
          const reasoning = tryExtractReasoning(part.rawValue);
          if (reasoning) {
            fullReasoning += reasoning;
            yield { type: 'reasoning-delta', text: reasoning };
          }
          break;
        }

        case 'text-delta': {
          fullText += part.text;
          yield { type: 'text-delta', text: part.text };
          break;
        }

        case 'reasoning-delta': {
          fullReasoning += part.text;
          yield { type: 'reasoning-delta', text: part.text };
          break;
        }

        case 'tool-input-start': {
          toolNameMap.set(part.id, part.toolName);
          toolArgsBuf.set(part.id, '');
          yield {
            type: 'tool-call-start',
            toolCallId: part.id,
            toolName: part.toolName,
          };
          break;
        }

        case 'tool-input-delta': {
          const existing = toolArgsBuf.get(part.id) || '';
          const updated = existing + part.delta;
          toolArgsBuf.set(part.id, updated);
          yield {
            type: 'tool-call-args',
            toolCallId: part.id,
            delta: part.delta,
          };
          break;
        }

        case 'tool-call': {
          const toolName = part.toolName;
          const input = (part.input ?? {}) as Record<string, unknown>;

          toolCallRecords.push({
            toolCallId: part.toolCallId,
            toolName,
            input,
            status: 'running',
          });

          yield {
            type: 'tool-call-end',
            toolCallId: part.toolCallId,
            toolName,
            input,
          };
          break;
        }

        case 'tool-result': {
          const toolName = part.toolName;
          const output = typeof part.output === 'string' ? part.output : JSON.stringify(part.output ?? {});
          const record = toolCallRecords.find(r => r.toolCallId === part.toolCallId);
          if (record) {
            record.output = output;
            record.status = 'done';
          }
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName,
            output,
            success: true,
          };
          break;
        }

        case 'tool-error': {
          const toolName = part.toolName;
          const errMsg = part.error instanceof Error ? part.error.message : String(part.error);
          const record = toolCallRecords.find(r => r.toolCallId === part.toolCallId);
          if (record) {
            record.output = errMsg;
            record.status = 'error';
          }
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName,
            output: errMsg,
            success: false,
          };
          break;
        }

        case 'finish-step': {
          stepNumber++;
          yield { type: 'step-finish', stepNumber };
          break;
        }

        // Ignore other part types (tool-input-end, start-step, etc.)
        default:
          break;
      }
    }

    yield { type: 'done', fullText, toolCalls: toolCallRecords, reasoning: fullReasoning };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    yield { type: 'error', error: message };
  }
}

// ---- Extract code from response ----

export function extractOpenSCADCode(markdown: string): string | null {
  const regex = /```(?:openscad|scad)?\s*\n([\s\S]*?)```/g;
  const matches: string[] = [];
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    matches.push(match[1].trim());
  }

  if (matches.length === 0) {
    const anyBlock = /```[\s\S]*?\n([\s\S]*?)```/g;
    let m;
    while ((m = anyBlock.exec(markdown)) !== null) {
      matches.push(m[1].trim());
    }
  }

  return matches.length > 0 ? matches[matches.length - 1] : null;
}
