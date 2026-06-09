import React, { useState, useRef, useEffect, useCallback, useContext, CSSProperties } from 'react';
import { Button } from 'primereact/button';
import { InputTextarea } from 'primereact/inputtextarea';
import { ModelContext } from './contexts';
import {
  ChatMessage,
  streamChat,
  hasStoredConfig,
} from '../ai/ai-service';
import { TOOL_LABELS, ToolCallRecord, MessagePart } from '../ai/tools';
import ApiKeyDialog from './ApiKeyDialog';

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'id-' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

const CHAT_STORAGE_KEY = 'openscad-ai-chat-v1';

interface SavedChatState {
  messages: ChatMessage[];
  codeSnapshots: Record<string, string>;
}

function loadChatState(): SavedChatState | null {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.messages)) {
      return { messages: parsed.messages, codeSnapshots: parsed.codeSnapshots || {} };
    }
    return null;
  } catch {
    return null;
  }
}

function saveChatState(state: SavedChatState): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded */ }
}

function clearChatState(): void {
  try {
    localStorage.removeItem(CHAT_STORAGE_KEY);
  } catch { /* ignore */ }
}

interface AiChatPanelProps {
  className?: string;
  style?: CSSProperties;
}

function ThinkingBlock({ reasoning, isStreaming }: { reasoning: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ marginBottom: '0.35rem' }}>
      <div
        className='flex align-items-center gap-1'
        style={{
          cursor: 'pointer',
          fontSize: '0.75rem',
          color: 'var(--text-color-secondary)',
          userSelect: 'none',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <i className={`pi ${expanded ? 'pi-chevron-down' : 'pi-chevron-right'}`} style={{ fontSize: '0.65rem' }} />
        <i className='pi pi-lightbulb' style={{ fontSize: '0.7rem', color: 'var(--yellow-500)' }} />
        <span>Thinking{isStreaming ? '...' : ''}</span>
      </div>
      {expanded && (
        <div style={{
          marginTop: '0.3rem',
          padding: '0.5rem',
          background: 'var(--surface-ground)',
          borderRadius: '6px',
          fontSize: '0.72rem',
          color: 'var(--text-color-secondary)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          maxHeight: '200px',
          overflowY: 'auto',
        }}>
          {reasoning}
        </div>
      )}
    </div>
  );
}

/** Format tool input for display */
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'read_code') return 'Reading current editor code...';
  if (toolName === 'edit_code') {
    const oldStr = (input.old_string as string) || '';
    const newStr = (input.new_string as string) || '';
    const oldPreview = oldStr.length > 80 ? oldStr.slice(0, 80) + '...' : oldStr;
    const newPreview = newStr.length > 80 ? newStr.slice(0, 80) + '...' : newStr;
    return `Replacing:\n  "${oldPreview}"\n→ "${newPreview}"`;
  }
  if (toolName === 'write_code') {
    const code = (input.code as string) || '';
    const lines = code.split('\n').length;
    return `Writing ${lines} lines of OpenSCAD code...`;
  }
  return JSON.stringify(input).slice(0, 120);
}

export default function AiChatPanel({ className, style: outerStyle }: AiChatPanelProps) {
  const model = useContext(ModelContext);
  const saved = useRef(loadChatState()).current;
  const [messages, setMessages] = useState<ChatMessage[]>(saved?.messages ?? []);
  const codeSnapshots = useRef<Record<string, string>>(saved?.codeSnapshots ?? {});
  const [inputText, setInputText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [apiKeyDialogVisible, setApiKeyDialogVisible] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef(model?.source ?? '');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveChatState({ messages, codeSnapshots: codeSnapshots.current });
  }, [messages]);

  useEffect(() => {
    codeRef.current = model?.source ?? '';
  }, [model?.source]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // ---- Markdown renderer ----
  const renderContent = useCallback((content: string) => {
    if (!content) return null;
    const lines = content.split('\n');
    const elements: React.ReactNode[] = [];
    let inCodeBlock = false;
    let codeBlockContent = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('```')) {
        if (inCodeBlock) {
          elements.push(
            <div key={`code-${i}`} style={{
              background: '#1e1e2e', color: '#cdd6f4',
              padding: '0.75rem', borderRadius: '6px',
              overflowX: 'auto', margin: '0.5rem 0',
              fontSize: '0.8rem', lineHeight: 1.4, maxWidth: '100%',
            }}>
              <pre style={{ margin: 0, whiteSpace: 'pre', fontFamily: 'Consolas, monospace', maxWidth: '100%' }}>
                {codeBlockContent}
              </pre>
            </div>
          );
          inCodeBlock = false;
          codeBlockContent = '';
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? '\n' : '') + line;
        continue;
      }

      let processed = line;
      processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      processed = processed.replace(/`([^`]+)`/g, '<code style="background:var(--surface-border);padding:1px 4px;border-radius:3px;font-size:0.8em;font-family:monospace;">$1</code>');

      if (processed.trim() === '') {
        elements.push(<br key={`br-${i}`} />);
      } else {
        elements.push(
          <p key={`p-${i}`} style={{ margin: '0.25em 0', overflowWrap: 'break-word', wordBreak: 'break-word' }} dangerouslySetInnerHTML={{ __html: processed }} />
        );
      }
    }

    if (inCodeBlock && codeBlockContent) {
      elements.push(
        <div key='code-final' style={{
          background: '#1e1e2e', color: '#cdd6f4', padding: '0.75rem',
          borderRadius: '6px', overflowX: 'auto', margin: '0.5rem 0',
          fontSize: '0.8rem', maxWidth: '100%',
        }}>
          <pre style={{ margin: 0, whiteSpace: 'pre', fontFamily: 'Consolas, monospace', maxWidth: '100%' }}>
            {codeBlockContent}
          </pre>
        </div>
      );
    }

    return elements;
  }, []);

  // ---- Tool call card (compact, no green output) ----
  const renderToolCard = useCallback((tc: ToolCallRecord) => {
    const meta = TOOL_LABELS[tc.toolName] || { icon: 'pi pi-cog', label: tc.toolName, color: 'var(--text-color-secondary)' };
    const isError = tc.status === 'error';

    return (
      <div style={{
        background: 'var(--surface-ground)',
        border: `1px solid ${isError ? 'var(--red-500)' : 'var(--surface-border)'}`,
        borderRadius: '8px',
        padding: '0.5rem 0.625rem',
        margin: '0.25rem 0',
        fontSize: '0.8rem',
      }}>
        <div className='flex align-items-center gap-2'>
          <i className={meta.icon} style={{ color: meta.color, fontSize: '0.85rem' }} />
          <span style={{ fontWeight: 600, color: meta.color, fontSize: '0.8rem' }}>{meta.label}</span>
          {tc.status === 'running' && (
            <i className='pi pi-spin pi-spinner' style={{ fontSize: '0.7rem', marginLeft: 'auto' }} />
          )}
          {tc.status === 'done' && (
            <i className='pi pi-check-circle' style={{ color: 'var(--green-500)', fontSize: '0.75rem', marginLeft: 'auto' }} />
          )}
          {tc.status === 'error' && (
            <i className='pi pi-exclamation-circle' style={{ color: 'var(--red-500)', fontSize: '0.75rem', marginLeft: 'auto' }} />
          )}
        </div>
        <div style={{
          fontSize: '0.72rem',
          color: 'var(--text-color-secondary)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'break-word',
          wordBreak: 'break-word',
          marginTop: '0.3rem',
          paddingLeft: '2px',
          borderLeft: '2px solid var(--surface-border)',
          padding: '0.15rem 0 0.15rem 0.5rem',
        }}>
          {formatToolInput(tc.toolName, tc.input)}
        </div>
      </div>
    );
  }, []);

  // ---- Send message ----
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isStreaming) return;

    if (!hasStoredConfig()) return;

    const userMsg: ChatMessage = { id: generateId(), role: 'user', content: text };
    codeSnapshots.current = { ...codeSnapshots.current, [userMsg.id]: codeRef.current };
    setMessages(prev => [...prev, userMsg]);
    setInputText('');
    setIsStreaming(true);
    setCurrentStep(0);

    const abortController = new AbortController();
    abortRef.current = abortController;

    const assistantId = generateId();
    const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '', isStreaming: true, parts: [] };
    setMessages(prev => [...prev, assistantMsg]);

    const conversationHistory = [...messages, userMsg].map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const parts: MessagePart[] = [];
    const pendingTCs = new Map<string, ToolCallRecord>();

    const syncMsg = () => {
      const textParts = parts.filter(p => p.type === 'text');
      const combined = textParts.map(p => (p as { content: string }).content).join('');
      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? {
          ...m,
          content: combined,
          parts: [...parts],
        } : m))
      );
    };

    try {
      const stream = streamChat(
        conversationHistory,
        codeRef,
        (newCode: string) => {
          if (model) model.source = newCode;
        },
        model?.state?.params?.activePath ?? 'main.scad',
        abortController.signal,
      );

      for await (const event of stream) {
        switch (event.type) {
          case 'text-delta': {
            const lastPart = parts[parts.length - 1];
            if (lastPart?.type === 'text') {
              lastPart.content += event.text;
            } else {
              parts.push({ type: 'text', content: event.text });
            }
            syncMsg();
            break;
          }

          case 'reasoning-delta': {
            const lastPart = parts[parts.length - 1];
            if (lastPart?.type === 'reasoning') {
              lastPart.content += event.text;
            } else {
              parts.push({ type: 'reasoning', content: event.text });
            }
            syncMsg();
            break;
          }

          case 'tool-call-start': {
            const record: ToolCallRecord = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: {},
              status: 'running',
            };
            pendingTCs.set(event.toolCallId, record);
            parts.push({ type: 'tool-call', toolCall: record });
            syncMsg();
            break;
          }

          case 'tool-call-args':
            break;

          case 'tool-call-end': {
            const record = pendingTCs.get(event.toolCallId);
            if (record) record.input = event.input;
            syncMsg();
            break;
          }

          case 'tool-result': {
            const record = pendingTCs.get(event.toolCallId);
            if (record) record.status = event.success ? 'done' : 'error';
            syncMsg();
            break;
          }

          case 'step-finish': {
            setCurrentStep(event.stepNumber);
            break;
          }

          case 'done': {
            // If event has reasoning but no reasoning-delta was emitted (e.g. Anthropic summary),
            // push it as a reasoning part
            if (event.reasoning && !parts.some(p => p.type === 'reasoning')) {
              parts.unshift({ type: 'reasoning', content: event.reasoning });
            }
            syncMsg();
            setMessages(prev =>
              prev.map(m => (m.id === assistantId ? {
                ...m,
                content: m.content || '(No response)',
                isStreaming: false,
                parts: [...parts],
              } : m))
            );
            break;
          }

          case 'error': {
            parts.push({ type: 'text', content: `❌ ${event.error}` });
            syncMsg();
            setMessages(prev =>
              prev.map(m => (m.id === assistantId ? { ...m, isStreaming: false, parts: [...parts] } : m))
            );
            break;
          }
        }
      }
    } catch (err: any) {
      const errMsg = `❌ Error: ${err.message ?? String(err)}`;
      parts.push({ type: 'text', content: errMsg });
      syncMsg();
      setMessages(prev =>
        prev.map(m => (m.id === assistantId ? { ...m, isStreaming: false, parts: [...parts] } : m))
      );
    }

    setIsStreaming(false);
    setCurrentStep(0);
    abortRef.current = null;
  }, [inputText, isStreaming, messages, model]);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const handleRewind = useCallback((msgId: string) => {
    const snapshot = codeSnapshots.current[msgId];
    if (snapshot !== undefined && model) {
      model.source = snapshot;
      codeRef.current = snapshot;
      const idx = messages.findIndex(m => m.id === msgId);
      if (idx >= 0) {
        const truncated = messages.slice(0, idx);
        const removedIds = messages.slice(idx).map(m => m.id);
        const newSnapshots = { ...codeSnapshots.current };
        for (const id of removedIds) delete newSnapshots[id];
        codeSnapshots.current = newSnapshots;
        setMessages(truncated);
      }
    }
  }, [model, messages]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const clearChat = useCallback(() => {
    setMessages([]);
    codeSnapshots.current = {};
    setCurrentStep(0);
    clearChatState();
  }, []);

  // -------- Styles --------
  const panelStyle: CSSProperties = {
    minHeight: 0,
    background: 'var(--surface-card)',
    overflow: 'hidden',
    border: '1px solid var(--surface-border)',
    borderRadius: '8px',
    opacity: 0.85,
    backdropFilter: 'blur(4px)',
    ...(outerStyle ?? {}),
    display: outerStyle?.display !== 'none' ? 'flex' : 'none',
    flexDirection: 'column',
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.625rem 0.75rem',
    borderBottom: '1px solid var(--surface-border)',
    background: 'var(--surface-ground)',
    flexShrink: 0,
  };

  const messagesAreaStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    padding: '0.75rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  };

  const inputAreaStyle: CSSProperties = {
    borderTop: '1px solid var(--surface-border)',
    padding: '0.625rem',
    flexShrink: 0,
  };

  return (
    <>
      <div className={className} style={panelStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div className='flex align-items-center gap-2'>
            <i className='pi pi-comment' style={{ fontSize: '1.1rem' }} />
            <span style={{ fontWeight: 600 }}>AI Agent</span>
          </div>
          <div className='flex gap-1'>
            <Button icon='pi pi-cog' rounded text size='small'
              tooltip='Configure AI' tooltipOptions={{ position: 'bottom' }}
              onClick={() => setApiKeyDialogVisible(true)} />
            <Button icon='pi pi-trash' rounded text size='small'
              tooltip='Clear chat' tooltipOptions={{ position: 'bottom' }}
              disabled={isStreaming}
              onClick={clearChat} />
          </div>
        </div>

        {/* Messages — absolute positioning prevents pushing parent */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={messagesAreaStyle} ref={scrollRef}>
            {messages.length === 0 && (
              <div style={{ textAlign: 'center', padding: '1.5rem 0.5rem', color: 'var(--text-color-secondary)' }}>
                <i className='pi pi-comments' style={{ fontSize: '2rem', opacity: 0.4, marginBottom: '0.5rem' }} />
                <h3 style={{ margin: '0.75rem 0 0.5rem', color: 'var(--text-color)', fontSize: '1.1rem' }}>
                  OpenSCAD AI Agent
                </h3>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', lineHeight: 1.4 }}>
                  I can directly read and edit your code. Try asking:
                </p>
                <ul style={{ textAlign: 'left', margin: '0 auto', paddingLeft: '1.5rem', fontSize: '0.825rem', maxWidth: '280px' }}>
                  <li style={{ marginBottom: '0.3rem' }}>"Create a parametric box with rounded corners"</li>
                  <li style={{ marginBottom: '0.3rem' }}>"Add a handle to this design"</li>
                  <li style={{ marginBottom: '0.3rem' }}>"Fix the syntax error on line 12"</li>
                  <li>"Make all dimensions customizable"</li>
                </ul>
              </div>
            )}

            {messages.map(msg => (
              <div key={msg.id} style={{
                display: 'flex', gap: '0.5rem', maxWidth: '100%',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              }}>
                {/* Avatar */}
                <div style={{
                  width: '28px', height: '28px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0, fontSize: '0.8rem',
                  ...(msg.role === 'user'
                    ? { background: 'var(--primary-color)', color: 'white' }
                    : { background: 'var(--surface-ground)', color: 'var(--text-color-secondary)' }
                  ),
                }}>
                  <i className={msg.role === 'user' ? 'pi pi-user' : 'pi pi-android'} />
                </div>

                {/* Content bubble */}
                <div style={{
                  flex: 1, minWidth: 0, fontSize: '0.85rem', lineHeight: 1.5,
                  position: 'relative',
                  ...(msg.role === 'user'
                    ? { background: 'var(--primary-color)', color: 'white', padding: '0.5rem 0.75rem', borderRadius: '12px 4px 12px 12px' }
                    : { background: 'var(--surface-ground)', padding: '0.5rem 0.75rem', borderRadius: '4px 12px 12px 12px' }
                  ),
                }}>
                  {/* Parts: interleaved reasoning + text + tool calls in call order */}
                  {msg.role === 'assistant' && msg.parts && msg.parts.length > 0
                    ? msg.parts.map((part, i) => {
                      if (part.type === 'reasoning') {
                        return <ThinkingBlock key={`r-${i}`} reasoning={part.content} isStreaming={msg.isStreaming} />;
                      }
                      if (part.type === 'text') {
                        return <React.Fragment key={`pt-${i}`}>{renderContent(part.content)}</React.Fragment>;
                      }
                      if (part.type === 'tool-call') {
                        return <React.Fragment key={`tc-${i}`}>{renderToolCard(part.toolCall)}</React.Fragment>;
                      }
                      return null;
                    })
                    : (msg.role === 'assistant' && msg.content ? renderContent(msg.content) : null)
                  }

                  {/* User message text */}
                  {msg.role === 'user' && (
                    <p style={{ overflowWrap: 'break-word', wordBreak: 'break-word' }}>{msg.content}</p>
                  )}

                  {/* Rewind button */}
                  {msg.role === 'user' && codeSnapshots.current[msg.id] !== undefined && (
                    <div style={{ position: 'absolute', top: '-6px', left: '-6px' }}>
                      <Button
                        size='small' rounded text
                        icon='pi pi-history'
                        tooltip='Rewind code to before this message'
                        tooltipOptions={{ position: 'left' }}
                        disabled={isStreaming}
                        style={{
                          width: '20px', height: '20px', padding: 0,
                          background: 'var(--surface-ground)', color: 'var(--text-color-secondary)',
                          fontSize: '0.65rem', opacity: isStreaming ? 0.3 : 0.7,
                        }}
                        onClick={(e) => { e.stopPropagation(); handleRewind(msg.id); }}
                      />
                    </div>
                  )}

                  {msg.isStreaming && !msg.content && !(msg.parts && msg.parts.length > 0) && (
                    <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', color: 'var(--primary-color)', fontWeight: 'bold' }}>▌</span>
                  )}
                </div>
              </div>
            ))}

            {isStreaming && currentStep > 0 && (
              <div className='flex align-items-center gap-2' style={{ fontSize: '0.75rem', color: 'var(--text-color-secondary)', padding: '0.25rem 0.5rem', justifyContent: 'center' }}>
                <i className='pi pi-spin pi-spinner' style={{ fontSize: '0.75rem' }} />
                <span>Step {currentStep} — AI is working...</span>
              </div>
            )}
          </div>
        </div>

        {/* Input */}
        <div style={{
          ...inputAreaStyle,
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.5rem',
        }}>
          <InputTextarea
            ref={inputRef}
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={hasStoredConfig()
              ? 'Ask the AI to edit your code... (Enter to send)'
              : 'Configure your API key to start...'}
            rows={2}
            autoResize
            disabled={isStreaming || !hasStoredConfig()}
            className='w-full'
          />
          {isStreaming ? (
            <Button icon='pi pi-stop' rounded severity='danger'
              onClick={handleStop} />
          ) : (
            <Button icon='pi pi-send' rounded severity='info'
              disabled={!inputText.trim()}
              onClick={handleSend} />
          )}
        </div>
      </div>

      <ApiKeyDialog visible={apiKeyDialogVisible} onHide={() => setApiKeyDialogVisible(false)} />
    </>
  );
}
