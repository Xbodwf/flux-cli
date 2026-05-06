import chalk from 'chalk';
import { AgentManager } from '../core/agent-manager.js';
import { Bridge } from '../core/bridge.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig, loadPersonas, saveConfig } from '../config/loader.js';
import type { AgentConfig, Persona, FluxConfig } from '../core/types.js';
import { t } from '../i18n/index.js';

/**
 * Command router — handles CLI subcommands.
 */

export async function handleCommand(
  args: string[],
  agentManager: AgentManager,
  bridge: Bridge,
  toolRegistry: ToolRegistry,
): Promise<boolean> {
  if (args.length === 0) return false;

  const cmd = args[0]!;

  switch (cmd) {
    case 'agent':
      return handleAgentCommand(args.slice(1), agentManager, bridge);
    case 'session':
      return handleSessionCommand(args.slice(1), agentManager);
    case 'config':
      return handleConfigCommand(args.slice(1));
    case 'persona':
      return handlePersonaCommand(args.slice(1));
    case 'bridge':
      return handleBridgeCommand(args.slice(1), bridge);
    case 'doctor':
      return handleDoctor(toolRegistry);
    default:
      return false;
  }
}

// ─── Agent Commands ───────────────────────────────────────────

async function handleAgentCommand(
  args: string[],
  agentManager: AgentManager,
  bridge: Bridge,
): Promise<boolean> {
  if (args.length === 0) {
    // List agents
    const agents = agentManager.listAgents();
    if (agents.length === 0) {
      console.log(t('cmd.no_agents'));
    } else {
      console.log(t('cmd.agents_header'));
      for (const a of agents) {
        console.log(`  ${a.id.padEnd(8)} ${a.name.padEnd(16)} ${a.provider.padEnd(12)} ${a.model.padEnd(30)} ${a.status}`);
      }
    }
    return true;
  }

  const sub = args[0]!;

  switch (sub) {
    case 'create': {
      const name = args[1] || 'default';
      const provider = args[2] || 'anthropic';
      const model = args[3] || '';
      const config: AgentConfig = {
        id: `${name}-${Date.now()}`,
        name,
        provider: provider as AgentConfig['provider'],
        model,
        persona: { name, description: '', prompt: 'You are a helpful AI assistant.' },
        tools: ['read_file', 'write_file', 'glob', 'grep', 'list_dir'],
      };
      const agent = await agentManager.createAgent(config);
      console.log(t('cmd.created_agent', { name: agent.name, id: agent.id }));
      break;
    }

    case 'rm': {
      const id = args[1];
      if (!id) { console.error(t('cmd.usage_agent_rm')); return true; }
      const ok = await agentManager.destroyAgent(id);
      console.log(ok ? t('cmd.removed_agent', { id }) : t('cmd.agent_not_found', { id }));
      break;
    }

    case 'inspect': {
      const id = args[1];
      if (!id) { console.error(t('cmd.usage_agent_inspect')); return true; }
      const agent = agentManager.getAgent(id);
      if (!agent) { console.error(t('cmd.agent_not_found', { id })); return true; }
      const state = agent.getState();
      console.log(`${t('cmd.agent_label')} ${state.config.name}`);
      console.log(`  ${t('cmd.agent_id')}     ${state.config.id}`);
      console.log(`  ${t('cmd.model_label')}  ${state.config.provider}/${state.config.model}`);
      console.log(`  ${t('cmd.status_label')} ${state.status}`);
      console.log(`  ${t('cmd.agent_persona')} ${state.config.persona.name}`);
      console.log(`  ${t('cmd.agent_session_entries')} ${state.session.length}`);
      console.log(`  ${t('cmd.agent_created')} ${new Date(state.createdAt).toISOString()}`);
      console.log(`  ${t('cmd.agent_last_active')} ${new Date(state.lastActiveAt).toISOString()}`);
      break;
    }

    default:
      console.error(t('cmd.unknown_sub', { cmd: 'agent', sub }));
      return false;
  }

  return true;
}

// ─── Session Commands ─────────────────────────────────────────

async function handleSessionCommand(
  args: string[],
  agentManager: AgentManager,
): Promise<boolean> {
  if (args.length === 0) {
    const { listSessions } = await import('../session/jsonl.js');
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log(t('cmd.no_sessions'));
    } else {
      console.log(t('cmd.sessions_header'));
      for (const s of sessions) {
        const sizeStr = s.size > 1024 ? `${(s.size / 1024).toFixed(1)} KB` : `${s.size} B`;
        console.log(`  ${s.name.padEnd(30)} ${sizeStr.padEnd(10)} ${s.compressed ? '(gzip)' : ''}`);
      }
    }
    return true;
  }

  switch (args[0]) {
    case 'save': {
      const agent = agentManager.getDefaultAgent();
      if (!agent) { console.log(t('index.no_agent')); return true; }
      const name = args[1] || `session-${Date.now()}`;
      const { writeSession, getSessionPath } = await import('../session/jsonl.js');
      const config = loadConfig();
      const path = getSessionPath(name);
      const entries = agent.getState().session;
      await writeSession(path, entries, config.sessionCompression);
      console.log(chalk.green(`Session saved: ${name} (${entries.length} entries)`));
      break;
    }

    case 'load': {
      const name = args[1];
      if (!name) { console.error(t('cmd.usage_session')); return true; }
      const { readSession, getSessionPath } = await import('../session/jsonl.js');
      const { existsSync } = await import('node:fs');
      const config = loadConfig();
      const path = getSessionPath(name);

      // Try uncompressed first, then compressed
      let entries: import('../core/types.js').SessionEntry[] = [];
      if (existsSync(path)) {
        entries = await readSession(path, false);
      } else if (existsSync(path + '.gz')) {
        entries = await readSession(path, true);
      } else {
        console.error(`Session not found: ${name}`);
        return true;
      }

      const agent = agentManager.getDefaultAgent();
      if (!agent) { console.log(t('index.no_agent')); return true; }
      const state = agent.getState();
      state.session = entries;
      agent.restoreState(state);
      const model = entries.find(e => e.model)?.model;
      if (model) {
        agent.setModel(model);
        saveConfig({ defaultModel: model });
      }
      console.log(chalk.green(`Session loaded: ${name} (${entries.length} entries)`));
      break;
    }

    case 'export': {
      const name = args[1];
      if (!name) { console.error('Usage: session export <name>'); return true; }
      const { readSession, getSessionPath } = await import('../session/jsonl.js');
      const { existsSync } = await import('node:fs');
      const config = loadConfig();
      const path = getSessionPath(name);

      let entries: import('../core/types.js').SessionEntry[] = [];
      if (existsSync(path)) {
        entries = await readSession(path, false);
      } else if (existsSync(path + '.gz')) {
        entries = await readSession(path, true);
      } else {
        console.error(`Session not found: ${name}`);
        return true;
      }

      for (const entry of entries) {
        if (entry.type === 'message' && entry.role && entry.content) {
          const role = entry.role === 'user' ? '## User' : '## Assistant';
          const content = typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2);
          console.log(`\n${role} (${new Date(entry.t).toISOString()}):\n${content}`);
        }
        if (entry.type === 'system_event' && entry.event) {
          console.log(`\n*[${entry.event}]*`);
        }
      }
      break;
    }

    default:
      console.error(t('cmd.usage_session'));
  }

  return true;
}

// ─── Config Commands ──────────────────────────────────────────

async function handleConfigCommand(args: string[]): Promise<boolean> {
  const config = loadConfig();

  if (args.length === 0) {
    console.log(t('cmd.config_header'));
    console.log(`  ${t('cmd.config_provider')} ${config.defaultProvider}`);
    console.log(`  ${t('cmd.config_model')}    ${config.defaultModel}`);
    console.log(`  ${t('cmd.config_session_dir')}      ${config.sessionDir}`);
    console.log(`  ${t('cmd.config_compression')}      ${config.sessionCompression}`);
    console.log(`  ${t('cmd.config_shell_confirm')}    ${config.shellConfirmRequired}`);
    console.log(`  ${t('cmd.config_theme')}            ${config.theme}`);
    console.log(`  ${t('cmd.config_auto_save')}        ${config.autoSaveInterval}s`);
    console.log('\n' + t('cmd.config_providers') + ':');
    for (const [key, val] of Object.entries(config.providers)) {
      const keyStatus = val.apiKey ? t('cmd.config_key_set') : t('cmd.config_key_not_set');
      console.log(`  ${key.padEnd(16)} ${val.defaultModel} (key: ${keyStatus})`);
    }
    return true;
  }

  switch (args[0]) {
    case 'set': {
      const key = args[1];
      const value = args[2];
      if (!key || !value) {
        console.error(t('cmd.usage_config'));
        return true;
      }
      saveConfig({ [key]: value } as unknown as Partial<FluxConfig>);
      console.log(t('cmd.set_config', { key, value }));
      break;
    }
    case 'edit': {
      const { execSync } = await import('node:child_process');
      const editor = process.env.EDITOR || 'nano';
      execSync(`${editor} ${process.env.HOME}/.flux_conf/config.yaml`, { stdio: 'inherit' });
      break;
    }
    default:
      console.error(t('cmd.usage_config'));
  }

  return true;
}

// ─── Persona Commands ─────────────────────────────────────────

async function handlePersonaCommand(args: string[]): Promise<boolean> {
  if (args.length === 0) {
    const personas = await loadPersonas();
    if (personas.size === 0) {
      console.log(t('cmd.no_personas'));
    } else {
      console.log(t('cmd.personas_header'));
      for (const [name, p] of personas) {
        console.log(`  ${name.padEnd(20)} ${p.description}`);
      }
    }
    return true;
  }

  switch (args[0]) {
    case 'create': {
      const name = args[1];
      if (!name) { console.error(t('cmd.usage_persona_create')); return true; }
      const persona: Persona = {
        name,
        description: args.slice(2).join(' ') || 'Custom persona',
        prompt: 'You are a helpful AI assistant.',
      };
      const { savePersona } = await import('../config/loader.js');
      await savePersona(persona);
      console.log(t('cmd.created_persona', { name }));
      break;
    }
    default:
      console.error(t('cmd.usage_persona'));
  }

  return true;
}

// ─── Bridge Commands ──────────────────────────────────────────

async function handleBridgeCommand(args: string[], bridge: Bridge): Promise<boolean> {
  if (args.length === 0) {
    const topo = bridge.getTopology();
    console.log(t('cmd.bridge_header'));
    console.log(`  ${t('cmd.bridge_agents')} ${topo.agents.length}`);
    for (const a of topo.agents) {
      console.log(`    ${a.id.padEnd(8)} ${a.name.padEnd(16)} ${a.status}`);
    }
    console.log(`  ${t('cmd.bridge_routes')} ${topo.routes.length}`);
    for (const r of topo.routes) {
      console.log(`    ${r.from} → ${r.to}${r.topic ? ` (topic: ${r.topic})` : ''}`);
    }
    console.log(`  ${t('cmd.bridge_messages')} ${topo.messageCount}`);
    return true;
  }

  switch (args[0]) {
    case 'connect': {
      const from = args[1];
      const to = args[2];
      if (!from || !to) { console.error(t('cmd.usage_bridge_connect')); return true; }
      bridge.addRoute({ from, to });
      console.log(t('cmd.route_added', { from, to }));
      break;
    }
    case 'route': {
      const from = args[1];
      const to = args[2];
      const topic = args[3];
      if (!from || !to) { console.error(t('cmd.usage_bridge_route')); return true; }
      bridge.addRoute({ from, to, topic });
      console.log(t('cmd.route_added', { from, to }) + (topic ? ` [topic: ${topic}]` : ''));
      break;
    }
    default:
      console.error(t('cmd.usage_bridge'));
  }

  return true;
}

// ─── Doctor ───────────────────────────────────────────────────

async function handleDoctor(toolRegistry: ToolRegistry): Promise<boolean> {
  console.log(t('cmd.doctor_title') + '\n');

  // Check config
  console.log(t('cmd.doctor_config_section'));
  try {
    const config = loadConfig();
    console.log('  ' + t('cmd.doctor_config_ok'));
    console.log('  ' + t('cmd.doctor_default', { provider: config.defaultProvider, model: config.defaultModel }));
  } catch (err) {
    console.log('  ' + t('cmd.doctor_config_error', { msg: String(err) }));
  }

  // Check tools
  console.log('\n' + t('cmd.doctor_tools_section'));
  const tools = toolRegistry.list();
  console.log('  ' + t('cmd.doctor_tools_registered', { n: tools.length }));
  for (const t of tools) {
    console.log(`    ✓ ${t.name}`);
  }

  // Check Node
  console.log('\n' + t('cmd.doctor_env_section'));
  console.log('  ' + t('cmd.doctor_node', { version: process.version }));
  console.log('  ' + t('cmd.doctor_platform', { platform: process.platform }));
  console.log('  ' + t('cmd.doctor_cwd', { cwd: process.cwd() }));

  console.log('\n' + t('cmd.doctor_checks_passed'));
  return true;
}
