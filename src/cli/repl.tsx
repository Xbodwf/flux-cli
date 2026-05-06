import React, { useState, useCallback, useEffect, useRef } from 'react';
import { render, Text, Box, Static, useInput } from 'ink';
import type { Instance } from 'ink';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from '../core/agent.js';
import { AgentManager } from '../core/agent-manager.js';
import { Bridge } from '../core/bridge.js';
import { ChatOrchestrator } from '../core/orchestrator.js';
import type { OrchestratorEvent } from '../core/orchestrator.js';
import { ToolRegistry } from '../tools/registry.js';
import { handleCommand } from './commands.js';
import { OutputLineComponent, StatusBarComponent } from './ink-ui.js';
import type { StatusBarInfo, OutputLine, OutputLineType } from './ink-ui.js';
import { ProviderConfigModal, ProviderSwitcher, LanguageSelector } from './provider-ui.js';
import { t } from '../i18n/index.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { writeSession, readSession, listSessions, getSessionPath } from '../session/jsonl.js';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

// ─── State persistence across unmount/remount cycles ─────────────

let _persistedLines: OutputLine[] = [];
let _persistedNextId = 0;
let _persistedDetailMode = false;
let _currentSessionPath: string | null = null;
let _initialSessionRendered = false;

function persistState(lines: OutputLine[], nextId: number, detailMode: boolean): void {
  _persistedLines = lines;
  _persistedNextId = nextId;
  _persistedDetailMode = detailMode;
}

function restoreState(): { lines: OutputLine[]; nextId: number; detailMode: boolean } {
  const s = { lines: _persistedLines, nextId: _persistedNextId, detailMode: _persistedDetailMode };
  _persistedLines = [];
  _persistedNextId = 0;
  _persistedDetailMode = false;
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
  const [input, setInput] = useState('');
  const [processing, setProcessing] = useState(false);
  const [spinnerText, setSpinnerText] = useState<string | null>(null);
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
  const abortRef = useRef<AbortController | null>(null);
  const isCleaningUpRef = useRef(false);
  const inputBufferRef = useRef<string[]>([]);
  const inMultiLineRef = useRef(false);
  const currentSpeakerIdRef = useRef<string | null>(null);
  const processingRef = useRef(false);
  const lastInputTimeRef = useRef(0);
  const pasteLineBufferRef = useRef<string[]>([]);

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
      persistState(linesRef.current, nextIdRef.current, detailModeRef.current);
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
          if (entry.role === 'user') {
            const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
            addLine('system', `\u276f ${content}`);
          } else if (entry.role === 'assistant') {
            const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
            const lines = content.split('\n');
            for (const line of lines) {
              processLine(line);
            }
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

  const appendDelta = useCallback((delta: string) => {
    const parts = delta.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i < parts.length - 1) {
        const completeLine = pendingPartialRef.current + part;
        pendingPartialRef.current = '';
        processLine(completeLine);
      } else {
        pendingPartialRef.current += part;
      }
    }
  }, [processLine]);

  const flushOutput = useCallback(() => {
    if (pendingPartialRef.current) {
      processLine(pendingPartialRef.current);
      pendingPartialRef.current = '';
    }
  }, [processLine]);

  // ─── Update status bar ────────────────────────────────────────
  const refreshStatus = useCallback(() => {
    const agentState = agent.getState();
    setStatusInfo({
      model: agentState.config.model,
      agentName: agent.name,
    });
  }, [agent]);

  // ─── Process user input via orchestrator ──────────────────────
  const processUserInput = useCallback(async (inputText: string): Promise<void> => {
    refreshStatus();

    setSpinnerText(t('repl.thinking'));

    const abortController = new AbortController();
    abortRef.current = abortController;
    currentSpeakerIdRef.current = null;

    try {
      for await (const event of orchestrator.chat(inputText, { signal: abortController.signal })) {
        // After abort, only show error/stop events (skip residual agent output)
        if (abortController.signal.aborted && event.type !== 'error' && event.type !== 'stop') continue;

        switch (event.type) {

          case 'text_delta': {
            setSpinnerText('');
            const isNewSpeaker = currentSpeakerIdRef.current !== event.agentId;
            currentSpeakerIdRef.current = event.agentId;
            const prefix = isNewSpeaker && event.agentId !== 'user'
              ? `[${event.agentId}] `
              : '';
            appendDelta(prefix + event.content);
            break;
          }

          case 'tool_call': {
            setSpinnerText('');
            addLine('tool_call', event.toolCall.name, { args: event.toolCall.args });
            break;
          }

          case 'tool_result': {
            const isError = event.toolResult.isError || false;
            const contentStr = event.toolResult.content
              .map(c => c.data)
              .join('\n');
            addLine('tool_result', event.toolCall, {
              fullContent: contentStr,
              isError,
            });
            setSpinnerText(t('repl.thinking'));
            break;
          }

          case 'routing': {
            addLine('system', `→ ${event.from} → ${event.to}`);
            break;
          }

          case 'stop': {
            flushOutput();
            refreshStatus();
            break;
          }

          case 'error': {
            if (abortController.signal.aborted) {
              addLine('system', t('repl.interrupted'));
            } else {
              const prefix = event.agentId !== 'system'
                ? `[${event.agentId}] `
                : '';
              addLine('error', prefix + event.content);
            }
            break;
          }
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        addLine('system', t('repl.interrupted'));
      } else {
        addLine('error', err instanceof Error ? err.message : String(err));
      }
    } finally {
      abortRef.current = null;
    }
  }, [orchestrator, agent, refreshStatus, appendDelta, addLine, flushOutput]);

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
        pendingPartialRef.current = '';
        inCodeBlockRef.current = false;
        codeBlockLangRef.current = '';
        codeBlockLinesRef.current = [];
        break;

      case 'agents':
        await requestInteractive(() =>
          handleCommand(['agent'], agentManager, bridge, toolRegistry) as Promise<unknown> as Promise<void>
        );
        // Re-read after interactive command
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
          addLine('system', `  ${r.from} → ${r.to}${r.topic ? ` (topic: ${r.topic})` : ''}`);
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
  }, [agentManager, bridge, toolRegistry, orchestrator, agent, addLine, refreshStatus, requestInteractive]);

  // ─── Cleanup helper ───────────────────────────────────────────
  function cleanup(): void {
    if (isCleaningUpRef.current) return;
    isCleaningUpRef.current = true;

    // Auto-save session on exit
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

    // Don't process repl input when a modal is active (modal has its own useInput)
    if (activeModalRef.current !== 'none') return;

    // Ctrl+C — interrupt if processing, exit if idle
    if (key.ctrl && (char === 'c' || char === 'C')) {
      if (processingRef.current) {
        abortRef.current?.abort();
        setProcessing(false);
        processingRef.current = false;
        addLine('system', t('repl.interrupted'));
      } else {
        cleanup();
      }
      return;
    }

    // Escape during processing — abort
    if (key.escape && processingRef.current) {
      abortRef.current?.abort();
      setProcessing(false);
      processingRef.current = false;
      addLine('system', t('repl.interrupted'));
      return;
    }

    // Ctrl+O — toggle detail mode for tool results
    if (key.ctrl && (char === 'o' || char === 'O')) {
      setDetailMode(d => !d);
      return;
    }

    if (key.ctrl && (char === 'd' || char === 'D')) {
      cleanup();
      return;
    }

    // Ignore other input while processing
    if (processingRef.current) return;

    // Enter
    if (key.return) {
      const trimmed = input.trim();

      // Shift+Enter — insert line break (multi-line continuation)
      if (key.shift) {
        inputBufferRef.current.push(input);
        inMultiLineRef.current = true;
        addLine('system', `│ ${input}`);
        setInput('');
        return;
      }

      // Paste detection: rapid Enter arrivals indicate pasted newlines
      if (isRapidSequence) {
        inputBufferRef.current.push(input);
        inMultiLineRef.current = true;
        addLine('system', `│ ${input}`);
        setInput('');
        return;
      }

      // In multi-line mode, Enter on non-empty input adds to buffer (like Shift+Enter)
      if (inMultiLineRef.current && trimmed) {
        inputBufferRef.current.push(input);
        addLine('system', `│ ${input}`);
        setInput('');
        return;
      }

      // Slash commands
      if (trimmed.startsWith('/') && !inMultiLineRef.current) {
        const fullCmd = trimmed.slice(1).trim();
        const parts = fullCmd.split(/\s+/);
        const command = parts[0]!;
        const cmdArgs = parts.slice(1);

        setInput('');

        // Modal-based interactive commands
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
        setProcessing(true);
        processingRef.current = true;
        setInput('');
        addLine('system', `❯ ${fullInput}`);
        addLine('separator', '');

        processUserInput(fullInput).finally(() => {
          setProcessing(false);
          processingRef.current = false;
        });
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

      // Single line submit
      inputBufferRef.current = [];
      inMultiLineRef.current = false;
      setProcessing(true);
      processingRef.current = true;
      setInput('');
      addLine('system', `❯ ${trimmed}`);
      addLine('separator', '');

      processUserInput(trimmed).finally(() => {
        setProcessing(false);
        processingRef.current = false;
      });
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
      {/* Persistent output history */}
      <Static items={lines}>
        {(line: OutputLine) => (
          <OutputLineComponent key={line.id} line={line} detailMode={detailMode} />
        )}
      </Static>

      {/* Spinner during processing */}
      {processing && spinnerText && (
        <Text dimColor>{spinnerText}</Text>
      )}

      {/* Input prompt when idle */}
      {!processing && (
        <Box>
          <Text bold color="#569CD6">❯ </Text>
          <Text>{input}</Text>
        </Box>
      )}

      {/* Status bar */}
      {statusInfo && (
        <StatusBarComponent status={statusInfo} />
      )}

      {/* Active modal overlay */}
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
 *
 * Uses a React component tree (Ink) for rendering instead of raw ANSI output.
 * Input is handled by Ink's useInput hook.
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

  let instance: Instance;

  /**
   * Run an interactive (non-Ink) command by temporarily destroying the Ink UI.
   */
  const requestInteractive = async <T,>(fn: () => Promise<T>): Promise<T> => {
    instance.unmount();
    try {
      await instance.waitUntilExit();
    } catch { /* Ink unmount cleanup */ }
    // Reset stdin to non-raw mode so the interactive command can set its own
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
  process.stdout.write('─'.repeat(Math.min(process.stdout.columns || 60, 60)) + '\n');

  instance = renderReplApp();

  // Wait forever — process exits via cleanup() on /exit or Ctrl+C
  await new Promise<void>(() => {});
}
