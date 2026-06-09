// Tool definitions for the AI agent using Vercel AI SDK
// These tools allow the AI to read and edit code in the editor

import { tool, jsonSchema } from 'ai';

export interface ToolContext {
  getCode: () => string;
  setCode: (code: string) => void;
  getActivePath: () => string;
}

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  error?: string;
  status: 'pending' | 'running' | 'done' | 'error';
}

export type MessagePart =
  | { type: 'text'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'tool-call'; toolCall: ToolCallRecord };

// ---- Tool Definitions ----

/**
 * Read the current editor code. The AI calls this to see what's in the editor
 * before making edits.
 */
export function createReadCodeTool(ctx: ToolContext) {
  return tool({
    description: `Read the current OpenSCAD code from the editor. Use this to see the full source before making changes. Always read the code first before editing.`,
    inputSchema: jsonSchema<{}>({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
    execute: async () => {
      const code = ctx.getCode();
      const path = ctx.getActivePath();
      if (!code.trim()) {
        return `File "${path}" is currently empty. Use write_code to create the initial content.`;
      }
      return `File: ${path}\n\nCurrent code:\n\`\`\`openscad\n${code}\n\`\`\``;
    },
  });
}

/**
 * Replace a specific section of code. This is the primary editing tool,
 * mimicking Claude Code's exact-string-replacement pattern.
 * The AI provides an exact `old_string` to find and `new_string` to replace it with.
 */
export function createEditCodeTool(ctx: ToolContext) {
  return tool({
    description: `Replace a specific section of code in the editor using exact string matching.

IMPORTANT RULES:
- old_string must match the EXISTING code exactly (including whitespace, indentation, blank lines, and surrounding code). Copy it verbatim.
- Use this to make targeted changes: fix a bug, add a parameter, change a value, insert a new module call, etc.
- For small changes, include just the lines being changed plus 2-3 lines of surrounding context for uniqueness.
- new_string should be the replacement code with the same indentation style.
- You can call this multiple times to make several edits in sequence.
- After editing, call read_code to verify your changes look correct.`,
    inputSchema: jsonSchema<{
      old_string: string;
      new_string: string;
    }>({
      type: 'object',
      properties: {
        old_string: {
          type: 'string',
          description: 'The exact code to replace. Must match the current file content exactly, including all whitespace and indentation. Include enough context (surrounding lines) to make it unique.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement code. Use the same indentation style as the original.',
        },
      },
      required: ['old_string', 'new_string'],
      additionalProperties: false,
    }),
    execute: async ({ old_string, new_string }) => {
      const code = ctx.getCode();
      const path = ctx.getActivePath();

      if (!code.includes(old_string)) {
        // Try to help the AI debug — show what's actually there
        const preview = code.length > 2000
          ? code.slice(0, 1000) + '\n... (truncated) ...\n' + code.slice(-1000)
          : code;

        // Check for common issues
        const suggestions: string[] = [];
        const oldTrimmed = old_string.trim();
        if (code.includes(oldTrimmed)) {
          suggestions.push('The content matches but whitespace/indentation differs. Copy the EXACT text from the file including leading/trailing spaces.');
        }
        // Find similar lines
        const oldLines = old_string.split('\n');
        for (const line of oldLines) {
          const trimmed = line.trim();
          if (trimmed && code.includes(trimmed)) {
            suggestions.push(`Found line "${trimmed.slice(0, 60)}${trimmed.length > 60 ? '...' : ''}" but surrounding context doesn't match. Include more context lines.`);
            break;
          }
        }
        if (suggestions.length === 0) {
          suggestions.push('The old_string was not found anywhere. Use read_code to see the current file content, then copy the exact text you want to replace.');
        }

        return `ERROR: Could not find old_string in the file.\n\n${suggestions.join('\n')}\n\nCurrent file content (for reference):\n\`\`\`openscad\n${preview}\n\`\`\``;
      }

      // Replace only the first occurrence
      const newCode = code.replace(old_string, new_string);
      ctx.setCode(newCode);

      const oldPreview = old_string.length > 300
        ? old_string.slice(0, 150) + '\n...' + old_string.slice(-150)
        : old_string;
      const newPreview = new_string.length > 300
        ? new_string.slice(0, 150) + '\n...' + new_string.slice(-150)
        : new_string;

      return `Successfully edited "${path}".\n\nReplaced:\n\`\`\`openscad\n${oldPreview}\n\`\`\`\n\nWith:\n\`\`\`openscad\n${newPreview}\n\`\`\``;
    },
  });
}

/**
 * Write the complete file content. Use this for creating new designs from scratch
 * or when making very large changes that would require many individual edits.
 */
export function createWriteCodeTool(ctx: ToolContext) {
  return tool({
    description: `Write the COMPLETE OpenSCAD code to the editor. This replaces ALL current content.

Use this when:
- Creating a new design from scratch
- The user asks for a completely different design
- Making changes so extensive that individual edits would be impractical

The code will be automatically rendered after writing.`,
    inputSchema: jsonSchema<{
      code: string;
    }>({
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The complete OpenSCAD source code to write to the editor. Must be valid, complete, self-contained OpenSCAD code.',
        },
      },
      required: ['code'],
      additionalProperties: false,
    }),
    execute: async ({ code }) => {
      ctx.setCode(code);
      const lineCount = code.split('\n').length;
      return `Successfully wrote ${lineCount} lines of OpenSCAD code to the editor. The preview will update automatically.`;
    },
  });
}

/**
 * Create the full tool set for the agent.
 * Returns both the tools object and a mutable context for tracking state.
 */
export function createAgentTools(ctx: ToolContext) {
  return {
    read_code: createReadCodeTool(ctx),
    edit_code: createEditCodeTool(ctx),
    write_code: createWriteCodeTool(ctx),
  };
}

/** Human-readable labels for tool names (used in UI) */
export const TOOL_LABELS: Record<string, { icon: string; label: string; color: string }> = {
  read_code: { icon: 'pi pi-book', label: 'Reading code', color: 'var(--blue-500)' },
  edit_code: { icon: 'pi pi-pencil', label: 'Editing code', color: 'var(--orange-500)' },
  write_code: { icon: 'pi pi-file-edit', label: 'Writing code', color: 'var(--green-500)' },
};
