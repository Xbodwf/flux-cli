import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Text, Box, Static, useInput } from 'ink';
import type { Instance } from 'ink';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from '../core/agent.js';
import { AgentManager } from '../core/agent-manager.js';
import { Bridge } from '../core/bridge.js';
import { ChatOrchestrator } from '../core/orchestrator.js';
import { ToolRegistry } from '../tools/registry.js';
import { handleCommand } from './commands.js';
import { OutputLineComponent, StatusBarComponent } from './ink-ui.js';
import type { StatusBarInfo, OutputLine, OutputLineType } from './ink-ui.js';
import type { ChatMessage, ToolCallDisplay, MessageRole } from '../chat/chat-types.js';
import { parseQuoteRef } from '../chat/chat-types.js';
import { ProviderConfigModal, ProviderSwitcher, LanguageSelector } from './provider-ui.js';
import { t } from '../i18n/index.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { writeSession, readSession, listSessions, getSessionPath } from '../session/jsonl.js';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

// ─── State persistence across unmount/remount cycles ─────────────

let _persistedLines: OutputLine[] = [];
let _persistedNextId = 0;
let _persistedDetailMode = false;
let _persistedChatMessages: ChatMessage[] = [];
let _persistedNextChatId = 0;
let _currentSessionPath: string | null = null;
let _initialSessionRendered = false;

function persistState(
  lines: OutputLine[], chatMessages: ChatMessage[],
  nextId: number, detailMode: boolean, nextChatId: number,
): void {
  _persistedLines = lines;
  _persistedChatMessages = chatMessages;
  _persistedNextId = nextId;
  _persistedDetailMode = detailMode;
  _persistedNextChatId = nextChatId;
}

function restoreState() {
  const s = {
    lines: _persistedLines,
    chatMessages: _persistedChatMessages,
    nextId: _persistedNextId,
    detailMode: _persistedDetailMode,
    nextChatId: _persistedNextChatId,
  };
  _persistedLines = [];
  _persistedNextId = 0;
  _persistedDetailMode = false;
  _persistedChatMessages = [];
  _persistedNextChatId = 0;
  return s;
}

// ─── REPL App Component ──────────────────────────────────────────

interface ReplAppProps {
  agentManager: AgentManager;
  bridge: Bridge;
  toolRegistry: ToolRegistry;
  orchestrator: ChatOrchestrator;
  agent: Agent;
  requestInteractive: <T>(fn: () => Promise<T>) => Promise<T>;
}

function ReplApp({
  agentManager,
  bridge,
  toolRegistry,
  orchestrator,
  agent,
  requestInteractive,
}: ReplAppProps) {
  // Restore persisted state from interactive command cycles
  const restored = useRef(restoreState());

  // ─── Rendering state ──────────────────────────────────────────
  const [lines, setLines] = useState<OutputLine[]>(restored.current.lines);
  const chatMessagesRef = useRef<ChatMessage[]>(restored.current.chatMessages);
  const [input, setInput] = useState('');
  const [processing, setProcessing] = useState(false);
  const [spinnerText, setSpinnerText] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [statusInfo, setStatusInfo] = useState<StatusBarInfo | null>({
    model: agent.getState().config.model,
    agentName: agent.name,
  });
  const [detailMode, setDetailMode] = useState(restored.current.detailMode);
  const [activeModal, setActiveModal] = useState<'none' | 'provider' | 'switch' | 'language'>('none');
  const activeModalRef = useRef(activeModal);
  activeModalRef.current = activeModal;

  // Refs for mutable state that should not trigger re-renders
  const nextIdRef = useRef(restored.current.nextId);
  const nextChatIdRef = useRef(restored.current.nextChatId);
  const abortRef = useRef<AbortController | null>(null);
  const isCleaningUpRef = useRef(false);
  const inputBufferRef = useRef<string[]>([]);
  const inMultiLineRef = useRef(false);
  const processingRef = useRef(false);
  const lastInputTimeRef = useRef(0);

  // Real-time chat refs
  const isGeneratingRef = useRef(false);
  const userMessageQueueRef = useRef<string[]>([]);

  // Code block state machine for line rendering
  const inCodeBlockRef = useRef(false);
  const codeBlockLangRef = useRef('');
  const codeBlockLinesRef = useRef<string[]>([]);
  const pendingPartialRef = useRef('');

  // Keep refs in sync with state so callbacks always see latest
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const detailModeRef = useRef(detailMode);
  detailModeRef.current = detailMode;

  // ─── Persist state on unmount ─────────────────────────────────
  useEffect(() => {
    return () => {
	    persistState(
	      linesRef.current, chatMessagesRef.current,
	      nextIdRef.current, detailModeRef.current, nextChatIdRef.current,
	    );
    };
  }, []);

  // ─── Render pre-existing session entries on mount (e.g. --session load) ──
  useEffect(() => {
    if (_initialSessionRendered) return;
    _initialSessionRendered = true;
    const sessionEntries = agent.getState().session;
    if (sessionEntries.length === 0) return;

    const timer = setTimeout(() => {
      for (const entry of sessionEntries) {
        if (entry.type === 'message') {
          const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
          if (entry.role === 'user') {
            addChatMessage('user', content, 'user', undefined, [], null);
          } else if (entry.role === 'assistant') {
            addChatMessage('assistant', content, entry.agentId || 'assistant', undefined, [], null);
          }
        } else if (entry.type === 'system_event') {
          if (entry.event !== 'scanner_routing') {
            addLine('system', `[event] ${entry.event}`);
          }
        }
      }
    }, 50);

    return () => clearTimeout(timer);
  }, []); // mount only

  // ─── Auto-save timer ──────────────────────────────────────────
  useEffect(() => {
    const fluxConfig = loadConfig();
    const interval = fluxConfig.autoSaveInterval || 0;
    if (interval <= 0) return;

    const timer = setInterval(async () => {
      try {
        const currentAgent = agentManager.getDefaultAgent();
        if (currentAgent && currentAgent.getState().session.length > 0) {
          await writeSession(
            join(homedir(), '.flux', 'sessions', 'autosave.jsonl'),
            currentAgent.getState().session,
            false,
          );
        }
      } catch { /* silent */ }
    }, interval * 1000);

    return () => clearInterval(timer);
  }, [agentManager]);

  // ─── Chat message management ──────────────────────────────────
  const addChatMessage = useCallback((
    role: MessageRole,
    content: string,
    agentId?: string,
    agentName?: string,
    toolCalls: ToolCallDisplay[] = [],
    quotedMessageId: number | null = null,
    isStreaming = false,
  ) => {
    const id = nextChatIdRef.current;
    nextChatIdRef.current += 1;
    const msg: ChatMessage = {
      id,
      role,
      agentId,
      agentName,
      content,
      quotedMessageId,
      timestamp: Date.now(),
      toolCalls,
      isStreaming,
    };
    // Keep chatMessagesRef in sync for quote lookups
    chatMessagesRef.current = [...chatMessagesRef.current, msg];
    // Add as chat_message line (single Static approach)
    const lineId = nextIdRef.current;
    nextIdRef.current += 1;
    setLines(prev => [...prev, {
      id: lineId,
      type: 'chat_message' as OutputLineType,
      content,
      meta: { chatMessage: msg, allMessages: chatMessagesRef.current },
    }]);
  }, []);

  // Save user message to agent session
  const saveUserToSession = useCallback((text: string) => {
    const defaultAgent = agentManager.getDefaultAgent();
    if (!defaultAgent) return;
    defaultAgent.addSessionEntry({
      t: Date.now(),
      type: 'message',
      agentId: defaultAgent.id,
      role: 'user',
      content: text,
    });
  }, [agentManager]);

  // Resolve agent name from agent ID
  const resolveAgentName = useCallback((agentId: string): string | undefined => {
    const a = agentManager.getAgent(agentId);
    return a?.name || a?.config?.alias || undefined;
  }, [agentManager]);

  // ─── Line management ──────────────────────────────────────────
  const addLine = useCallback((type: OutputLineType, content: string, meta?: Record<string, unknown>) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setLines(prev => [...prev, { id, type, content, meta }]);
  }, []);

  const processLine = useCallback((line: string) => {
    if (line.startsWith('```')) {
      if (inCodeBlockRef.current) {
        addLine('code_block', '', {
          language: codeBlockLangRef.current,
          code: codeBlockLinesRef.current.join('\n'),
        });
        inCodeBlockRef.current = false;
        codeBlockLangRef.current = '';
        codeBlockLinesRef.current = [];
      } else {
        inCodeBlockRef.current = true;
        codeBlockLangRef.current = line.slice(3).trim();
      }
      return;
    }

    if (inCodeBlockRef.current) {
      codeBlockLinesRef.current.push(line);
      return;
    }

    if (!line.trim()) {
      addLine('empty', '');
      return;
    }

    if (/^#{1,6}\s/.test(line)) {
      addLine('header', line);
    } else if (/^\|.*\|$/.test(line) && line.includes('|', 1)) {
      addLine('table', line);
    } else if (line.startsWith('> ')) {
      addLine('blockquote', line);
    } else if (/^(\s*)([-*+]\s|\d+\.\s)/.test(line)) {
      addLine('list', line);
    } else if (/^[-*_]{3,}\s*$/.test(line)) {
      addLine('separator', '');
    } else {
      addLine('text', line);
    }
  }, [addLine]);

  // ─── Update status bar ────────────────────────────────────────
  const refreshStatus = useCallback(() => {
    const agentState = agent.getState();
    setStatusInfo({
      model: agentState.config.model,
      agentName: agent.name,
      activeAgents: agentManager.getActiveAgentCount(),
    });
  }, [agent, agentManager]);

  // ─── Process user input via orchestrator ──────────────────────
  const processUserInput = useCallback(async (inputText: string): Promise<void> => {
    refreshStatus();
    isGeneratingRef.current = true;

    // Episode-local state for this generation run (reset each call)
    let paragraphBuf = '';
    let currentAgentId = 'default';
    let currentAgentName: string | undefined;
    let currentToolCalls: ToolCallDisplay[] = [];

    const abortController = new AbortController();
    abortRef.current = abortController;

    // Helper: flush one complete paragraph as a ChatMessage
    const scannerId = orchestrator.getScannerAgent()?.id;
    const flushParagraph = (text: string) => {
      if (!text.trim() && currentToolCalls.length === 0) return;
      // Skip displaying scanner text output — routing events show delegation
      if (currentAgentId === scannerId && scannerId) {
        currentToolCalls = [];
        return;
      }
      addChatMessage(
        'assistant', text,
        currentAgentId, currentAgentName || resolveAgentName(currentAgentId),
        [...currentToolCalls], null, false,
      );
      // Save assistant message to agent session
      saveAssistantToSession(text);
      currentToolCalls = [];
    };

    // Helper: save assistant paragraph to agent session for context continuity
    const saveAssistantToSession = (text: string) => {
      if (!text.trim()) return;
      const defaultAgent = agentManager.getDefaultAgent();
      if (!defaultAgent) return;
      defaultAgent.addSessionEntry({
        t: Date.now(),
        type: 'message',
        agentId: currentAgentId,
        role: 'assistant',
        content: text,
      });
    };

    // Helper: save user messages to agent session
    const saveUserToSession = (text: string) => {
      const defaultAgent = agentManager.getDefaultAgent();
      if (!defaultAgent) return;
      defaultAgent.addSessionEntry({
        t: Date.now(),
        type: 'message',
        agentId: defaultAgent.id,
        role: 'user',
        content: text,
      });
    };

    // Helper: check queue, save to session, abort, and start new generation
    const handleQueueAndRestart = async (): Promise<boolean> => {
      const queued = userMessageQueueRef.current;
      if (queued.length === 0) return false;

      userMessageQueueRef.current = [];

      // Save partial assistant output so LLM has context
      if (paragraphBuf.trim()) {
        saveAssistantToSession(paragraphBuf);
        flushParagraph(paragraphBuf);
        paragraphBuf = '';
      }

      // Save queued user messages to session
      for (const q of queued) {
        saveUserToSession(q);
        addChatMessage('user', q, 'user', undefined, [], null, false);
      }

      // Abort current orchestrator run
      abortController.abort();

      // Start new generation with the first queued message
      const nextInput = queued[0]!;
      setSpinnerText(t('repl.thinking'));
      await processUserInput(nextInput);
      return true;
    };

    try {
      for await (const event of orchestrator.chat(inputText, { signal: abortController.signal })) {
        if (abortController.signal.aborted) break;

        switch (event.type) {

          case 'text_delta': {
            setSpinnerText(null);

            // Track agent identity
            if (event.agentId) {
              currentAgentId = event.agentId;
              currentAgentName = resolveAgentName(event.agentId);
            }

            // Accumulate into paragraph buffer
            paragraphBuf += event.content;

            // Show streaming content in real-time (re-renders on every delta)
            setStreamingContent(paragraphBuf);

            // Detect paragraph boundaries (\n\n) in the stream
            if (paragraphBuf.includes('\n\n')) {
              const parts = paragraphBuf.split('\n\n');

              // All parts except the last are complete paragraphs
              for (let i = 0; i < parts.length - 1; i++) {
                const complete = parts[i]!;
                if (complete.trim()) {
                  flushParagraph(complete);
                }
              }

              // Keep the last (potentially incomplete) part as the buffer
              paragraphBuf = parts[parts.length - 1]!;

              // Update streaming content to reflect the new buffer
              setStreamingContent(paragraphBuf);

              // After each complete paragraph, check for queued user input
              const restarted = await handleQueueAndRestart();
              if (restarted) return;
            }
            break;
          }

          case 'tool_call': {
            setSpinnerText(null);
            currentToolCalls.push({
              id: event.toolCall.id,
              name: event.toolCall.name,
              args: event.toolCall.args,
            });
            break;
          }

          case 'tool_result': {
            const tc = currentToolCalls.find(t => t.id === event.toolCall);
            if (tc) {
              tc.result = {
                content: event.toolResult.content.map(c => c.data).join('\n'),
                isError: event.toolResult.isError || false,
              };
            }
            break;
          }

          case 'routing': {
            // Show scanner delegation — strip @mentions from task to avoid duplication
            const cleanTask = event.task.replace(/@\w[\w-]*/g, '').trim();
            addChatMessage(
              'scanner',
              cleanTask ? `→ @${event.to} ${cleanTask}` : `→ @${event.to}`,
              event.from,
              resolveAgentName(event.from),
              [], null, false,
            );
            break;
          }

          case 'stop': {
            // Flush final paragraph
            if (paragraphBuf.trim() || currentToolCalls.length > 0) {
              flushParagraph(paragraphBuf);
              paragraphBuf = '';
            }
            setStreamingContent('');
            refreshStatus();
            break;
          }

          case 'error': {
            if (abortController.signal.aborted) {
              addLine('system', t('repl.interrupted'));
            } else {
              const prefix = event.agentId !== 'system' ? `[${event.agentId}] ` : '';
              addLine('error', prefix + event.content);
            }
            break;
          }
        }
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        addLine('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      isGeneratingRef.current = false;
      abortRef.current = null;
      setProcessing(false);
      processingRef.current = false;

      // Flush any remaining paragraph buffer
      if (paragraphBuf.trim() || currentToolCalls.length > 0) {
        flushParagraph(paragraphBuf);
        paragraphBuf = '';
      }
      setStreamingContent('');

      // Process any queued messages that arrived during/after generation
      const queued = userMessageQueueRef.current;
      if (queued.length > 0) {
        userMessageQueueRef.current = [];
        const nextInput = queued[0]!;
        setProcessing(true);
        processingRef.current = true;
        isGeneratingRef.current = true;
        await processUserInput(nextInput);
      }
    }
  }, [orchestrator, agent, refreshStatus, addChatMessage, addLine, resolveAgentName, agentManager, setStreamingContent]);

  // ─── Slash command handler ────────────────────────────────────
  const handleSlashCommand = useCallback(async (command: string, args: string[]): Promise<void> => {
    switch (command) {

      case 'help':
        addLine('system', '/provider   Provider configuration');
        addLine('system', '/language  Switch language');
        addLine('system', '/help       Show this help');
        addLine('system', '/exit       Exit the REPL');
        addLine('system', '/clear      Clear screen');
        addLine('system', '/agents     Manage agents');
        addLine('system', '/bridge     View bridge topology');
        addLine('system', '/status     Show all agents status');
        addLine('system', '/doctor     Run system diagnostics');
        addLine('system', '/model      Show/switch models');
        addLine('system', '            /model         — all agents');
        addLine('system', '            /model name    — specific agent');
        addLine('system', '            /model name m  — set model');
        addLine('system', '/switch     Quick provider switcher');
        addLine('system', '/resume     Resume autosaved session');
        addLine('system', '/session    List, save, load, or start a new session');
        break;

      case 'exit':
      case 'quit':
        cleanup();
        break;

      case 'clear':
        setLines([]);
        nextIdRef.current = 0;
        chatMessagesRef.current = [];
        nextChatIdRef.current = 0;
        pendingPartialRef.current = '';
        inCodeBlockRef.current = false;
        codeBlockLangRef.current = '';
        codeBlockLinesRef.current = [];
        break;

      case 'agents':
        await requestInteractive(() =>
          handleCommand(['agent'], agentManager, bridge, toolRegistry) as Promise<unknown> as Promise<void>
        );
        refreshStatus();
        break;

      case 'doctor':
        await requestInteractive(() =>
          handleCommand(['doctor'], agentManager, bridge, toolRegistry) as Promise<unknown> as Promise<void>
        );
        refreshStatus();
        break;

      case 'bridge': {
        const topo = bridge.getTopology();
        addLine('system', `${t('cmd.bridge_header')}: ${topo.agents.length} agents, ${topo.routes.length} routes`);
        for (const a of topo.agents) {
          addLine('system', `  ${a.id} ${a.name} [${a.status}]`);
        }
        for (const r of topo.routes) {
          addLine('system', `  ${r.from} \u2192 ${r.to}${r.topic ? ` (topic: ${r.topic})` : ''}`);
        }
        addLine('system', `  Messages: ${topo.messageCount}`);
        break;
      }

      case 'status': {
        const defaultAgent = agentManager.getDefaultAgent();
        if (defaultAgent) {
          const state = defaultAgent.getState();
          addLine('system', `Status: ${state.status}`);
          addLine('system', `Model:  ${state.config.provider}/${state.config.model}`);
          addLine('system', `Agent:  ${state.config.name} (${state.config.id})`);
          addLine('system', `Session entries: ${state.session.length}`);
        }
        break;
      }

      case 'model': {
        if (args.length === 0) {
          const allAgents = agentManager.listAgents();
          if (allAgents.length === 0) {
            addLine('system', 'No agents.');
          } else {
            addLine('system', 'Agents:');
            for (const a of allAgents) {
              const agentObj = agentManager.getAgent(a.id);
              const alias = agentObj?.config?.alias;
              const aliasStr = alias ? ` (@${alias})` : '';
              const builtin = agentObj?.config?.isBuiltin ? ' [built-in]' : '';
              addLine('system', `  ${a.name}${aliasStr}${builtin}`);
              addLine('system', `    ${a.provider}/${a.model}  [${a.status}]`);
            }
          }
        } else if (args.length === 1) {
          const target = agentManager.getAgentByName(args[0]!);
          if (!target) {
            addLine('system', `Agent not found: ${args[0]}`);
          } else {
            const state = target.getState();
            const alias = state.config.alias ? ` (@${state.config.alias})` : '';
            addLine('system', `${state.config.name}${alias}`);
            addLine('system', `  Provider: ${state.config.provider}`);
            addLine('system', `  Model:    ${state.config.model}`);
            addLine('system', `  Status:   ${state.status}`);
            addLine('system', `  Persona:  ${state.config.persona.name}`);
            addLine('system', `  Tools:    ${state.config.tools.join(', ')}`);
          }
        } else if (args.length >= 2) {
          const target = agentManager.getAgentByName(args[0]!);
          if (!target) {
            addLine('system', `Agent not found: ${args[0]}`);
          } else {
            const newModel = args.slice(1).join(' ');
            target.setModel(newModel);
            setStatusInfo({
              model: newModel,
              agentName: target.name,
            });
            addLine('system', `${target.name}: model set to ${newModel}`);
          }
        }
        break;
      }

      case 'resume': {
        const autosavePath = join(homedir(), '.flux', 'sessions', 'autosave');
        let entries: import('../core/types.js').SessionEntry[] = [];
        if (existsSync(autosavePath + '.jsonl')) {
          entries = await readSession(autosavePath, false);
        } else if (existsSync(autosavePath + '.jsonl.gz')) {
          entries = await readSession(autosavePath, true);
        } else {
          addLine('system', 'No autosaved session found.');
          break;
        }
        const resumeAgent = agentManager.getDefaultAgent();
        if (!resumeAgent) { addLine('error', t('index.no_agent')); break; }
        const state = resumeAgent.getState();
        state.session = entries;
        resumeAgent.restoreState(state);
        const model = entries.find(e => e.model)?.model;
        if (model) {
          resumeAgent.setModel(model);
          saveConfig({ defaultModel: model });
        }
        setStatusInfo({
          model: model || resumeAgent.getState().config.model,
          agentName: resumeAgent.name,
        });
        addLine('system', `Session resumed: ${entries.length} entries restored`);
        _currentSessionPath = join(homedir(), '.flux', 'sessions', 'autosave.jsonl');
        break;
      }

      case 'session': {
        const subCmd = args[0];
        if (!subCmd || subCmd === 'list') {
          const sessions = await listSessions();
          if (sessions.length === 0) {
            addLine('system', 'No saved sessions.');
          } else {
            addLine('system', 'Saved sessions:');
            for (const s of sessions) {
              const sizeStr = s.size > 1024 ? `${(s.size / 1024).toFixed(1)} KB` : `${s.size} B`;
              addLine('system', `  ${s.name}  ${sizeStr}`);
            }
          }
          break;
        }

        const sessionAgent = agentManager.getDefaultAgent();
        if (!sessionAgent) { addLine('error', t('index.no_agent')); break; }

        switch (subCmd) {
          case 'save': {
            const name = args[1] || `session-${Date.now()}`;
            const path = getSessionPath(name);
            const entries = sessionAgent.getState().session;
            const config = loadConfig();
            await writeSession(path, entries, config.sessionCompression);
            _currentSessionPath = path;
            addLine('system', `Session saved: ${name} (${entries.length} entries)`);
            break;
          }

          case 'load': {
            const name = args[1];
            if (!name) { addLine('system', 'Usage: /session load <name>'); break; }
            const path = getSessionPath(name);
            let entries: import('../core/types.js').SessionEntry[] = [];
            if (existsSync(path)) {
              entries = await readSession(path, false);
            } else if (existsSync(path + '.gz')) {
              entries = await readSession(path, true);
            } else {
              addLine('system', `Session not found: ${name}`);
              break;
            }
            const agentState = sessionAgent.getState();
            agentState.session = entries;
            sessionAgent.restoreState(agentState);
            const model = entries.find(e => e.model)?.model;
            if (model) {
              sessionAgent.setModel(model);
              saveConfig({ defaultModel: model });
            }
            setStatusInfo({
              model: model || sessionAgent.getState().config.model,
              agentName: sessionAgent.name,
            });
            const msgCount = entries.filter(e => e.type === 'message').length;
            _currentSessionPath = path;
            addLine('system', `Session loaded: ${name} (${msgCount} messages, ${entries.length} entries)`);

            // Render loaded entries into the display
            for (const entry of entries) {
              if (entry.type === 'message') {
                const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
                if (entry.role === 'user') {
                  addChatMessage('user', content, 'user', undefined, [], null);
                } else if (entry.role === 'assistant') {
                  addChatMessage('assistant', content, entry.agentId || 'assistant', undefined, [], null);
                }
              } else if (entry.type === 'system_event') {
                if (entry.event !== 'scanner_routing') {
                  addLine('system', `[event] ${entry.event}`);
                }
              }
            }
            break;
          }

          case 'new': {
            _currentSessionPath = null;
            const agentState = sessionAgent.getState();
            agentState.session = [];
            sessionAgent.restoreState(agentState);
            addLine('system', 'Started new session. Previous context cleared.');
            break;
          }

          default:
            addLine('system', `Unknown session subcommand: ${subCmd}. Try: save, load, list, new`);
        }
        break;
      }

      default:
        addLine('system', `Unknown command: /${command}`);
    }
  }, [agentManager, bridge, toolRegistry, orchestrator, agent, addLine, addChatMessage, refreshStatus, requestInteractive]);

  // ─── Cleanup helper ───────────────────────────────────────────
  function cleanup(): void {
    if (isCleaningUpRef.current) return;
    isCleaningUpRef.current = true;

    try {
      const currentAgent = agentManager.getDefaultAgent();
      if (currentAgent && currentAgent.getState().session.length > 0) {
        const entries = currentAgent.getState().session;
        const sessionDir = join(homedir(), '.flux', 'sessions');
        if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
        const path = _currentSessionPath || join(sessionDir, `session-${Date.now()}.jsonl`);
        const name = _currentSessionPath
          ? path.replace(/\.jsonl(\.gz)?$/, '').split('/').pop()!
          : `session-${Date.now()}`;
        const data = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
        writeFileSync(path, data, 'utf-8');
        process.stdout.write(`\n\u2713 Session saved: ${name}\n`);
        if (!_currentSessionPath) {
          process.stdout.write(`  To resume: flux session load ${name}\n`);
        }
      }
    } catch { /* silent */ }

    process.stdout.write('Goodbye!\n');
    process.exit(0);
  }

  // ─── Keyboard handling ────────────────────────────────────────
  useInput((char, key) => {
    // Track timing for paste/multi-line detection
    const now = Date.now();
    const timeSinceLastInput = now - lastInputTimeRef.current;
    lastInputTimeRef.current = now;
    const isRapidSequence = timeSinceLastInput < 50 && timeSinceLastInput > 0;

    // Don't process repl input when a modal is active
    if (activeModalRef.current !== 'none') return;

    // Ctrl+C — interrupt if generating, exit if idle
    if (key.ctrl && (char === 'c' || char === 'C')) {
      if (isGeneratingRef.current || processingRef.current) {
        abortRef.current?.abort();
        isGeneratingRef.current = false;
        setProcessing(false);
        processingRef.current = false;
        addLine('system', t('repl.interrupted'));
      } else {
        cleanup();
      }
      return;
    }

    // Escape during generation — abort
    if (key.escape && isGeneratingRef.current) {
      abortRef.current?.abort();
      isGeneratingRef.current = false;
      setProcessing(false);
      processingRef.current = false;
      addLine('system', t('repl.interrupted'));
      return;
    }

    // Ctrl+O — toggle detail mode
    if (key.ctrl && (char === 'o' || char === 'O')) {
      setDetailMode(d => !d);
      return;
    }

    if (key.ctrl && (char === 'd' || char === 'D')) {
      cleanup();
      return;
    }

    // ─── Enter key ────────────────────────────────────────────
    if (key.return) {
      const trimmed = input.trim();

      // Shift+Enter — insert line break (multi-line continuation)
      if (key.shift) {
        inputBufferRef.current.push(input);
        inMultiLineRef.current = true;
        addLine('system', `\u2502 ${input}`);
        setInput('');
        return;
      }

      // Paste detection: rapid Enter arrivals indicate pasted newlines
      if (isRapidSequence) {
        inputBufferRef.current.push(input);
        inMultiLineRef.current = true;
        addLine('system', `\u2502 ${input}`);
        setInput('');
        return;
      }

      // In multi-line mode, Enter on non-empty input adds to buffer
      if (inMultiLineRef.current && trimmed) {
        inputBufferRef.current.push(input);
        addLine('system', `\u2502 ${input}`);
        setInput('');
        return;
      }

      // Slash commands (only when not generating)
      if (trimmed.startsWith('/') && !inMultiLineRef.current && !isGeneratingRef.current) {
        const fullCmd = trimmed.slice(1).trim();
        const parts = fullCmd.split(/\s+/);
        const command = parts[0]!;
        const cmdArgs = parts.slice(1);

        setInput('');

        if (command === 'language' || command === 'lang') {
          setActiveModal('language');
          return;
        }
        if (command === 'switch') {
          setActiveModal('switch');
          return;
        }
        if (command === 'provider') {
          setActiveModal('provider');
          return;
        }

        addLine('separator', '');
        setProcessing(true);
        processingRef.current = true;

        handleSlashCommand(command, cmdArgs).finally(() => {
          setProcessing(false);
          processingRef.current = false;
        });
        return;
      }

      // Submit on empty line in multi-line mode
      if (trimmed === '' && inputBufferRef.current.length > 0) {
        const fullInput = inputBufferRef.current.join('\n');
        inputBufferRef.current = [];
        inMultiLineRef.current = false;
        setInput('');

        // Parse quote ref
        const { quoteId, cleanText } = parseQuoteRef(fullInput);

        // Show user message as ChatMessage
        addChatMessage('user', fullInput, 'user', undefined, [], quoteId, false);

        saveUserToSession(cleanText || fullInput);
        if (isGeneratingRef.current) {
          // Queue message during generation
          const finalText = quoteId !== null ? `>${quoteId} ${cleanText}` : cleanText;
          userMessageQueueRef.current.push(finalText || cleanText);
        } else {
          addLine('separator', '');
          setProcessing(true);
          processingRef.current = true;
          processUserInput(cleanText || fullInput);
        }
        return;
      }

      // Skip empty single line
      if (trimmed === '' && inputBufferRef.current.length === 0) {
        setInput('');
        return;
      }

      // Multi-line continuation (ends with \)
      if (trimmed.endsWith('\\')) {
        inputBufferRef.current.push(trimmed.slice(0, -1));
        inMultiLineRef.current = true;
        setInput('');
        return;
      }

      // ─── Single line submit ────────────────────────────────
      inputBufferRef.current = [];
      inMultiLineRef.current = false;
      setInput('');

      // Parse quote ref from input
      const { quoteId, cleanText } = parseQuoteRef(trimmed);

      // Show user message as ChatMessage (with quote info)
      addChatMessage('user', trimmed, 'user', undefined, [], quoteId, false);

      saveUserToSession(cleanText || trimmed);
      if (isGeneratingRef.current) {
        // Queue message during generation
        userMessageQueueRef.current.push(cleanText || trimmed);
      } else {
        // Start generation
        addLine('separator', '');
        setProcessing(true);
        processingRef.current = true;
        processUserInput(cleanText || trimmed);
      }
      return;
    }

    // Backspace
    if (key.backspace || key.delete) {
      setInput(prev => prev.slice(0, -1));
      return;
    }

    // Regular character (accept any non-empty char, including CJK/IME input)
    if (char) {
      setInput(prev => prev + char);
    }
  });

  // ─── Render ───────────────────────────────────────────────────
  return (
    <Box flexDirection="column">
      {/* Single Static for all output — chat messages + system lines */}
      <Static items={lines}>
        {(line: OutputLine) => (
          <OutputLineComponent key={line.id} line={line} detailMode={detailMode} />
        )}
      </Static>

      {/* Streaming paragraph — rendered in real-time outside Static */}
      {streamingContent && (
        <Box>
          <Text dimColor>{' │ '}</Text>
          <Text>{streamingContent}</Text>
        </Box>
      )}

      {/* Spinner during processing */}
      {processing && spinnerText && (
        <Text dimColor>{spinnerText}</Text>
      )}

      {/* Always-visible input bar */}
      <Box>
        <Text bold color="#569CD6">{'\u276f'} </Text>
        <Text>{input}</Text>
        {isGeneratingRef.current && (
          <Text dimColor> ({t('repl.thinking')})</Text>
        )}
      </Box>

      {/* Status bar */}
      {statusInfo && (
        <StatusBarComponent status={statusInfo} />
      )}

      {/* Active modal overlays */}
      {activeModal === 'provider' && (
        <ProviderConfigModal onDone={(configured: boolean) => {
          setActiveModal('none');
          if (configured) {
            addLine('system', t('repl.provider_success'));
          }
        }} />
      )}
      {activeModal === 'switch' && (
        <ProviderSwitcher onDone={(switched: boolean) => {
          setActiveModal('none');
          if (switched) {
            addLine('system', t('switch.success_msg'));
          }
        }} />
      )}
      {activeModal === 'language' && (
        <LanguageSelector onDone={(changed: boolean) => {
          setActiveModal('none');
          if (changed) {
            addLine('system', t('repl.language_changed'));
          }
        }} />
      )}
    </Box>
  );
}

// ─── Entry Point ─────────────────────────────────────────────────

/**
 * REPL mode — interactive terminal with Ink-based rich UI.
 */
export async function startREPL(
  agentManager: AgentManager,
  bridge: Bridge,
  toolRegistry: ToolRegistry,
  orchestrator: ChatOrchestrator,
): Promise<void> {
  const agentOrNull = agentManager.getDefaultAgent();
  if (!agentOrNull) {
    process.stderr.write('No default agent available.\n');
    return;
  }
  const agent: Agent = agentOrNull;

  // Reset persisted state for a fresh start
  _persistedLines = [];
  _persistedNextId = 0;
  _persistedDetailMode = false;
  _persistedChatMessages = [];
  _persistedNextChatId = 0;

  let instance: Instance;

  /**
   * Run an interactive (non-Ink) command by temporarily destroying the Ink UI.
   */
  const requestInteractive = async <T,>(fn: () => Promise<T>): Promise<T> => {
    instance.unmount();
    try {
      await instance.waitUntilExit();
    } catch { /* Ink unmount cleanup */ }
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    try {
      const result = await fn();
      return result;
    } finally {
      instance = renderReplApp();
    }
  };

  const renderReplApp = (): Instance => {
    return render(
      <ReplApp
        agentManager={agentManager}
        bridge={bridge}
        toolRegistry={toolRegistry}
        orchestrator={orchestrator}
        agent={agent}
        requestInteractive={requestInteractive}
      />,
      {
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
      },
    );
  };

  // Show initial banner via console (before Ink app renders)
  process.stdout.write('Flux REPL\n');
  process.stdout.write('Type /help for commands\n');
  process.stdout.write('\u2500'.repeat(Math.min(process.stdout.columns || 60, 60)) + '\n');

  instance = renderReplApp();

  // Wait forever — process exits via cleanup() on /exit or Ctrl+C
  await new Promise<void>(() => {});
}
