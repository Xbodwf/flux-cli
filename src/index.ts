#!/usr/bin/env node

import chalk from 'chalk';
import { EventBus } from './core/event-bus.js';
import { Bridge } from './core/bridge.js';
import { AgentManager } from './core/agent-manager.js';
import { ToolRegistry } from './tools/registry.js';
import { registerBuiltinTools } from './tools/builtin.js';
import { loadConfig, loadPersonas, ensureDirs, loadAgentConfigs, saveAgentConfig } from './config/loader.js';
import { startREPL } from './cli/repl.js';
import { handleCommand } from './cli/commands.js';
import { showProviderConfigUI, hasConfiguredProvider } from './cli/provider-ui.js';
import { t } from './i18n/index.js';
import { loadScannerPrompt } from './core/prompt-loader.js';
import { ChatOrchestrator } from './core/orchestrator.js';
import type { AgentConfig, CLIOptions } from './core/types.js';

async function main() {
  // Parse CLI args
  const args = process.argv.slice(2);
  const options = parseOptions(args);

  if (options.version) {
    const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
    console.log(t('index.version', { version: pkg.version }));
    process.exit(0);
  }

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Ensure config directories exist
  ensureDirs();

  // Bootstrap system
  const bus = new EventBus();
  const tools = new ToolRegistry();
  const bridge = new Bridge(bus);
  const agentManager = new AgentManager(bus, bridge, tools);

  // Register built-in tools
  registerBuiltinTools(tools);

  // Load config
  const config = loadConfig();
  const personas = await loadPersonas();

  // If no providers configured, show interactive setup
  if (!hasConfiguredProvider() && !options.help && !options.version) {
    const configured = await showProviderConfigUI();
    if (!configured) {
      console.log(t('index.no_provider'));
    }
  }

  // Create default agent
  const defaultPersona = personas.get('default') || {
    name: 'default',
    description: 'Default general-purpose agent',
    prompt: 'You are a helpful AI assistant. You can use tools to read and write files, search code, and explore directory structures.',
    temperature: 0.3,
  };

  const defaultConfig: AgentConfig = {
    id: 'default',
    name: 'Default',
    provider: config.defaultProvider,
    model: options.model || config.defaultModel,
    persona: defaultPersona,
    tools: ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_dir', 'read_files', 'memory_save', 'memory_search', 'memory_list'],
    temperature: defaultPersona.temperature,
  };

  await agentManager.createAgent(defaultConfig);

  // Load session if --session flag is provided
  if (options.session) {
    try {
      const { readSession, getSessionPath } = await import('./session/jsonl.js');
      const { existsSync } = await import('node:fs');
      const path = getSessionPath(options.session);
      let entries: import('./core/types.js').SessionEntry[] = [];
      if (existsSync(path)) {
        entries = await readSession(path, false);
      } else if (existsSync(path + '.gz')) {
        entries = await readSession(path, true);
      }
      if (entries.length > 0) {
        const agent = agentManager.getDefaultAgent();
        if (agent) {
          const state = agent.getState();
          state.session = entries;
          agent.restoreState(state);
          const model = entries.find(e => e.model)?.model;
          if (model) agent.setModel(model);
          console.log(`Session loaded: ${options.session} (${entries.length} entries)`);
        }
      }
    } catch (err) {
      console.error(`Failed to load session: ${err}`);
    }
  }

  // ─── Multi-Agent Orchestrator Setup ──────────────────────────
  const orchestrator = new ChatOrchestrator(agentManager, bridge);

  // Load existing agent configs from ~/.flux/agents/
  const loadedConfigs = await loadAgentConfigs();

  // If no agent YAMLs exist yet (first launch), copy built-in YAMLs to ~/.flux/agents/
  if (loadedConfigs.size === 0) {
    const { readFileSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const builtinDir = join(dirname(fileURLToPath(import.meta.url)), 'persona', 'builtin');
    const agentsDir = join((await import('node:os')).homedir(), '.flux', 'agents');
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });
    for (const file of ['coder.yaml', 'reviewer.yaml']) {
      const src = join(builtinDir, file);
      if (existsSync(src)) {
        writeFileSync(join(agentsDir, file), readFileSync(src, 'utf-8'), 'utf-8');
      }
    }
    // Reload configs after copying
    const { loadAgentConfigs: reloadConfigs } = await import('./config/loader.js');
    const freshConfigs = await reloadConfigs();
    for (const [k, v] of freshConfigs) {
      loadedConfigs.set(k, v);
    }
  }

  // Create agents from all loaded configs
  for (const [, agentConfig] of loadedConfigs) {
    await agentManager.createAgent(agentConfig);
  }

  // Create scanner agent (built-in, programmatic — no YAML file)
  const scannerConfig: AgentConfig = {
    id: 'scanner',
    name: 'scanner',
    provider: config.defaultProvider,
    model: config.defaultModel,
    persona: {
      name: 'scanner',
      description: 'Built-in task routing agent',
      prompt: loadScannerPrompt(),
      temperature: 0.2,
    },
    tools: [],
    isBuiltin: true,
  };
  const scannerAgent = await agentManager.createAgent(scannerConfig);
  orchestrator.setScannerAgent(scannerAgent);

  // Check for subcommands
  if (args.length > 0 && !args[0]!.startsWith('-')) {
    const handled = await handleCommand(args, agentManager, bridge, tools);
    if (!handled) {
      // Treat as one-shot query if not a known command
      await handleOneShot(args.join(' '), agentManager);
    }
    process.exit(0);
  }

  // REPL mode
  await startREPL(agentManager, bridge, tools, orchestrator);
}

/**
 * Parse CLI options.
 */
function parseOptions(args: string[]): CLIOptions {
  const options: CLIOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    switch (arg) {
      case '--version':
      case '-v':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--config':
      case '-c':
        options.config = args[++i];
        break;
      case '--session':
      case '-s':
        options.session = args[++i];
        break;
      case '--agent':
      case '-a':
        options.agent = args[++i];
        break;
      case '--model':
      case '-m':
        options.model = args[++i];
        break;
      case '--provider':
      case '-p':
        options.provider = args[++i] as CLIOptions['provider'];
        break;
      case '--verbose':
        options.verbose = true;
        break;
    }
  }

  // Pipe mode: detect if stdin is not a TTY
  options.pipe = !process.stdin.isTTY;

  return options;
}

/**
 * Handle one-shot query (non-REPL, non-command).
 */
async function handleOneShot(query: string, agentManager: AgentManager): Promise<void> {
  const agent = agentManager.getDefaultAgent();
  if (!agent) {
    console.error(t('index.no_agent'));
    process.exit(1);
  }

  const message = { role: 'user' as const, content: query };

  for await (const event of agent.chat([message])) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.content || '');
        break;
      case 'error':
        process.stderr.write(`\n${t('index.error_prefix')} ${event.content}\n`);
        break;
    }
  }

  process.stdout.write('\n');
}

/**
 * Show help text.
 */
function showHelp(): void {
  const helpText = `
${t('index.help_title')}

${chalk.bold(t('index.help_usage'))}
  flux                  ${t('index.help_repl')}
  flux <query>          ${t('index.help_oneshot')}
  flux [command]        ${t('index.help_subcommand')}

${chalk.bold(t('index.help_commands_header'))}
  agent                 ${t('index.help_agent')}
  session               ${t('index.help_session')}
  config                ${t('index.help_config')}
  persona               ${t('index.help_persona')}
  bridge                ${t('index.help_bridge')}
  doctor                ${t('index.help_doctor')}

${chalk.bold(t('index.help_options_header'))}
  --model, -m <name>    ${t('index.help_model_opt')}
  --provider, -p <name> ${t('index.help_provider_opt')}
  --session, -s <path>  ${t('index.help_session_opt')}
  --verbose             ${t('index.help_verbose')}
  --version, -v         ${t('index.help_version')}
  --help, -h            ${t('index.help_help')}

${chalk.bold(t('index.help_pipe'))}
  echo "refactor this" | flux
  cat main.ts | flux "${t('index.help_oneshot')}"

${chalk.bold(t('index.help_env'))}
  ANTHROPIC_API_KEY     ${t('index.help_anthropic_key')}
  OPENAI_API_KEY        ${t('index.help_openai_key')}
  GEMINI_API_KEY        ${t('index.help_gemini_key')}
  FLUX_DEFAULT_MODEL    ${t('index.help_model_opt')}
  FLUX_DEFAULT_PROVIDER ${t('index.help_provider_opt')}

${t('index.help_config_path')}
${t('index.help_sessions_path')}
`;
  console.log(helpText);
}

main().catch(err => {
  console.error(t('index.fatal_error'), err);
  process.exit(1);
});
