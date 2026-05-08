import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentConfig, WeaveConfig, Persona, ProviderConfig, ProviderType } from '../core/types.js';
import { setLocale } from '../i18n/index.js';

const WEAVE_CONF_DIR = join(homedir(), '.weave');
const DEFAULT_SESSION_DIR = join(WEAVE_CONF_DIR, 'sessions');
const AGENTS_DIR = join(WEAVE_CONF_DIR, 'agents');

const DEFAULT_CONFIG: WeaveConfig = {
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-20250505',
  providers: {},
  sessionDir: DEFAULT_SESSION_DIR,
  sessionCompression: true,
  personasDir: join(WEAVE_CONF_DIR, 'personas'),
  autoSaveInterval: 30,
  shellConfirmRequired: true,
  theme: 'auto',
};

/**
 * Load configuration from ~/.weave/
 *
 * Priority: defaults < config.yaml < environment variables
 */
export function loadConfig(): WeaveConfig {
  const configPath = join(WEAVE_CONF_DIR, 'config.yaml');
  const providersPath = join(WEAVE_CONF_DIR, 'providers.yaml');
  const keysPath = join(WEAVE_CONF_DIR, 'keys.yaml');

  let config = { ...DEFAULT_CONFIG };

  // Load config.yaml
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = parseYaml(raw) as Partial<WeaveConfig>;
    config = { ...config, ...parsed };
  }

  // Load providers.yaml (provider settings without keys)
  if (existsSync(providersPath)) {
    const raw = readFileSync(providersPath, 'utf-8');
    const parsed = parseYaml(raw) as { providers?: Partial<Record<ProviderType, Partial<ProviderConfig>>> };
    if (parsed?.providers) {
      config.providers = {} as Record<ProviderType, ProviderConfig>;
      for (const [key, val] of Object.entries(parsed.providers)) {
        if (val) {
          config.providers[key as ProviderType] = {
            ...val,
            type: key as ProviderType,
          } as ProviderConfig;
        }
      }
    }
  }

  // Load keys.yaml (API keys, mounted separately for security)
  if (existsSync(keysPath)) {
    const raw = readFileSync(keysPath, 'utf-8');
    const parsed = parseYaml(raw) as { api_keys?: Record<string, string> };
    if (parsed?.api_keys) {
      for (const [provider, key] of Object.entries(parsed.api_keys)) {
        const providerConfig = config.providers[provider as ProviderType];
        if (providerConfig) {
          providerConfig.apiKey = key;
        }
      }
    }
  }

  // Environment variable overrides
  if (process.env.WEAVE_DEFAULT_PROVIDER) {
    config.defaultProvider = process.env.WEAVE_DEFAULT_PROVIDER as ProviderType;
  }
  if (process.env.WEAVE_DEFAULT_MODEL) {
    config.defaultModel = process.env.WEAVE_DEFAULT_MODEL;
  }

  // Apply saved locale
  if (config.locale) {
    setLocale(config.locale);
  }

  // Create provider entries from env vars if they don't exist in providers.yaml
  if (process.env.ANTHROPIC_API_KEY) {
    if (!config.providers.anthropic) {
      config.providers.anthropic = { type: 'anthropic', defaultModel: 'claude-sonnet-4-20250505' };
    }
    config.providers.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (process.env.OPENAI_API_KEY) {
    if (!config.providers.openai) {
      config.providers.openai = { type: 'openai', defaultModel: 'gpt-4o' };
    }
    config.providers.openai.apiKey = process.env.OPENAI_API_KEY;
  }
  if (process.env.GEMINI_API_KEY) {
    if (!config.providers.google) {
      config.providers.google = { type: 'google', defaultModel: 'gemini-2.0-flash' };
    }
    config.providers.google.apiKey = process.env.GEMINI_API_KEY;
  }

  return config;
}

/**
 * Save config back to config.yaml (partial update, preserves unknown keys).
 */
export function saveConfig(updates: Partial<WeaveConfig>): void {
  ensureDirs();

  const configPath = join(WEAVE_CONF_DIR, 'config.yaml');
  const existing = existsSync(configPath)
    ? parseYaml(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    : {};

  const merged = { ...existing, ...updates };
  writeFileSync(configPath, stringifyYaml(merged), 'utf-8');
}

/**
 * Load all personas from the personas directory.
 */
export async function loadPersonas(): Promise<Map<string, Persona>> {
  const personasDir = join(WEAVE_CONF_DIR, 'personas');
  const personas = new Map<string, Persona>();

  if (!existsSync(personasDir)) {
    return personas;
  }

  const files = await readdir(personasDir);
  for (const file of files) {
    if (extname(file) !== '.yaml' && extname(file) !== '.yml') continue;
    const raw = await readFile(join(personasDir, file), 'utf-8');
    const persona = parseYaml(raw) as Persona;
    if (persona?.name) {
      personas.set(persona.name, persona);
    }
  }

  return personas;
}

/**
 * Save a persona to the personas directory.
 */
export async function savePersona(persona: Persona): Promise<void> {
  const dir = join(WEAVE_CONF_DIR, 'personas');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${persona.name}.yaml`),
    stringifyYaml(persona),
    'utf-8',
  );
}

/**
 * Ensure config directories exist.
 */
export function ensureDirs(): void {
  for (const dir of [WEAVE_CONF_DIR, join(WEAVE_CONF_DIR, 'personas'), DEFAULT_SESSION_DIR, AGENTS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Load all agent configs from ~/.weave/agents/.
 * Each file is a single YAML describing one AgentConfig.
 */
export async function loadAgentConfigs(): Promise<Map<string, AgentConfig>> {
  const agents = new Map<string, AgentConfig>();

  if (!existsSync(AGENTS_DIR)) {
    return agents;
  }

  const files = await readdir(AGENTS_DIR);
  for (const file of files) {
    if (extname(file) !== '.yaml' && extname(file) !== '.yml') continue;
    const raw = await readFile(join(AGENTS_DIR, file), 'utf-8');
    try {
      const parsed = parseYaml(raw) as Record<string, unknown>;
      if (!parsed?.name) continue;

      // Convert flat YAML to AgentConfig shape
      const personaRaw = parsed.persona as Record<string, unknown> | undefined;
      const config: AgentConfig = {
        id: parsed.id as string || (parsed.name as string),
        name: parsed.name as string,
        alias: parsed.alias as string | undefined,
        provider: (parsed.provider as ProviderType) || 'anthropic' as ProviderType,
        model: parsed.model as string || '',
        persona: {
          name: (personaRaw?.name as string) || (parsed.name as string),
          description: (personaRaw?.description as string) || '',
          prompt: (personaRaw?.prompt as string) || 'You are a helpful AI assistant.',
          temperature: personaRaw?.temperature as number | undefined,
          modelPreference: personaRaw?.modelPreference as string | undefined,
          tools: personaRaw?.tools as string[] | undefined,
          rules: personaRaw?.rules as string[] | undefined,
        },
        tools: (parsed.tools as string[]) || [],
        isBuiltin: parsed.isBuiltin as boolean || false,
        maxTokens: parsed.maxTokens as number | undefined,
        temperature: parsed.temperature as number | undefined,
        maxHistoryEntries: parsed.maxHistoryEntries as number | undefined,
      };
      agents.set(config.name, config);
    } catch {
      // skip invalid files
    }
  }

  return agents;
}

/**
 * Save an agent config to ~/.weave/agents/.
 */
export async function saveAgentConfig(config: AgentConfig): Promise<void> {
  await mkdir(AGENTS_DIR, { recursive: true });

  // Serialize to a clean YAML structure
  const yamlObj: Record<string, unknown> = {
    name: config.name,
    alias: config.alias,
    provider: config.provider,
    model: config.model,
    persona: {
      name: config.persona.name,
      description: config.persona.description,
      prompt: config.persona.prompt,
      ...(config.persona.temperature !== undefined ? { temperature: config.persona.temperature } : {}),
      ...(config.persona.modelPreference ? { modelPreference: config.persona.modelPreference } : {}),
      ...(config.persona.tools ? { tools: config.persona.tools } : {}),
      ...(config.persona.rules ? { rules: config.persona.rules } : {}),
    },
    tools: config.tools,
    maxHistoryEntries: config.maxHistoryEntries,
  };

  if (config.maxTokens !== undefined) yamlObj.maxTokens = config.maxTokens;
  if (config.temperature !== undefined) yamlObj.temperature = config.temperature;

  await writeFile(
    join(AGENTS_DIR, `${config.name}.yaml`),
    stringifyYaml(yamlObj),
    'utf-8',
  );
}
