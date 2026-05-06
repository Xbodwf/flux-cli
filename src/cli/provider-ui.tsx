import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Text, Box, useInput, render } from 'ink';
import { ensureDirs, saveConfig, loadConfig } from '../config/loader.js';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stringify as stringifyYaml, parse as parseYaml } from 'yaml';
import { t, detectLocale, setLocale } from '../i18n/index.js';
import type { ProviderType } from '../core/types.js';

// ─── Types ──────────────────────────────────────────────────────────

interface ProviderOption {
  id: string;
  name: string;
  needsKey: boolean;
  defaultModel: string;
  defaultUrl: string;
}

const PROVIDERS: ProviderOption[] = [
  { id: 'anthropic', name: 'Anthropic', needsKey: true, defaultModel: 'claude-sonnet-4-20250505', defaultUrl: 'https://api.anthropic.com' },
  { id: 'openai', name: 'OpenAI', needsKey: true, defaultModel: 'gpt-4o', defaultUrl: 'https://api.openai.com/v1' },
  { id: 'google', name: 'Google', needsKey: true, defaultModel: 'gemini-2.0-flash', defaultUrl: 'https://generativelanguage.googleapis.com' },
  { id: 'ollama', name: 'Ollama', needsKey: false, defaultModel: 'llama3', defaultUrl: 'http://localhost:11434' },
];

const FLUX_CONF_DIR = join(homedir(), '.flux_conf');
const KEYS_PATH = join(FLUX_CONF_DIR, 'keys.yaml');
const PROVIDERS_PATH = join(FLUX_CONF_DIR, 'providers.yaml');

// ─── Save Config Helpers ────────────────────────────────────────────

function saveProviderConfig(providerId: string, apiKey?: string, baseUrl?: string) {
  ensureDirs();

  // Save API key to keys.yaml
  let keysData: { api_keys?: Record<string, string> } = {};
  if (existsSync(KEYS_PATH)) {
    try { keysData = parseYaml(readFileSync(KEYS_PATH, 'utf-8')) as typeof keysData; }
    catch { /* ignore */ }
  }
  if (!keysData.api_keys) keysData.api_keys = {};
  if (apiKey) keysData.api_keys[providerId] = apiKey;
  writeFileSync(KEYS_PATH, stringifyYaml(keysData), 'utf-8');

  // Save base URL to providers.yaml
  if (baseUrl) {
    let providersData: Record<string, unknown> = {};
    if (existsSync(PROVIDERS_PATH)) {
      try { providersData = parseYaml(readFileSync(PROVIDERS_PATH, 'utf-8')) as Record<string, unknown>; }
      catch { /* ignore */ }
    }
    if (!providersData.providers) providersData.providers = {};
    const pd = providersData.providers as Record<string, Record<string, unknown>>;
    if (!pd[providerId]) pd[providerId] = {};
    pd[providerId]!.baseUrl = baseUrl;
    writeFileSync(PROVIDERS_PATH, stringifyYaml(providersData), 'utf-8');
  }

  // Set default provider in config
  saveConfig({ defaultProvider: providerId as ProviderType });

  // Set env var for current session
  const envMap: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GEMINI_API_KEY' };
  if (apiKey && envMap[providerId]) process.env[envMap[providerId]] = apiKey;
}

// ─── Check if any provider is configured ────────────────────────────

export function hasConfiguredProvider(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY) {
    return true;
  }
  if (existsSync(KEYS_PATH)) {
    try {
      const raw = readFileSync(KEYS_PATH, 'utf-8');
      const parsed = parseYaml(raw) as { api_keys?: Record<string, string> } | null;
      if (parsed?.api_keys) {
        return Object.values(parsed.api_keys).some(k => k && k.length > 0);
      }
    } catch { /* ignore */ }
  }
  return false;
}

// ─── Shared box-drawing helpers ─────────────────────────────────────

function BoxTop({ title }: { title: string }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold color="#569CD6">{'╔══════════════════════════════════════╗'}</Text>
      <Text bold color="#569CD6">{'║'}     {title.padEnd(30)}{'║'}</Text>
      <Text bold color="#569CD6">{'╚══════════════════════════════════════╝'}</Text>
    </Box>
  );
}

// ─── Language Selector ──────────────────────────────────────────────

const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
];

export function LanguageSelector({ onDone }: { onDone: (changed: boolean) => void }): React.JSX.Element {
  const [idx, setIdx] = useState(() => Math.max(0, LANGUAGES.findIndex(l => l.id === detectLocale())));

  useInput((_char, key) => {
    if (key.upArrow) { setIdx(i => (i - 1 + LANGUAGES.length) % LANGUAGES.length); return; }
    if (key.downArrow) { setIdx(i => (i + 1) % LANGUAGES.length); return; }
    if (key.return) {
      setLocale(LANGUAGES[idx]!.id);
      saveConfig({ locale: LANGUAGES[idx]!.id });
      onDone(true);
      return;
    }
    if (key.escape) { onDone(false); return; }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <BoxTop title="Select Language" />
      <Box marginTop={1} flexDirection="column">
        {LANGUAGES.map((lang, i) => (
          <Text key={lang.id}>
            {i === idx ? <Text bold color="cyan">  ▸ {lang.label}</Text> : <Text>    {lang.label}</Text>}
            {i === idx ? <Text dimColor>  {'←'}</Text> : null}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>  [↑/↓] navigate  [Enter] confirm  [Esc] skip</Text>
      </Box>
    </Box>
  );
}

// ─── Provider Switcher ──────────────────────────────────────────────

export function ProviderSwitcher({ onDone }: { onDone: (switched: boolean) => void }): React.JSX.Element {
  const [idx, setIdx] = useState(0);

  useInput((_char, key) => {
    if (key.upArrow) { setIdx(i => (i - 1 + PROVIDERS.length) % PROVIDERS.length); return; }
    if (key.downArrow) { setIdx(i => (i + 1) % PROVIDERS.length); return; }
    if (key.return) {
      saveConfig({ defaultProvider: PROVIDERS[idx]!.id as ProviderType });
      onDone(true);
      return;
    }
    if (key.escape) { onDone(false); return; }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <BoxTop title={t('switch.title')} />
      <Box marginTop={1} flexDirection="column">
        {PROVIDERS.map((p, i) => {
          const descKey = `provider.desc_${p.id}` as const;
          return (
            <Text key={p.id}>
              {i === idx
                ? <Text bold color="cyan">  ▸ {p.name}</Text>
                : <Text>    {p.name}</Text>
              }
              <Text dimColor> — {t(descKey)}</Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>  [↑/↓] navigate  [Enter] confirm  [Esc] skip</Text>
      </Box>
    </Box>
  );
}

// ─── Provider Config Modal ──────────────────────────────────────────

type ConfigStep = 'select' | 'url_input' | 'key_input';

export function ProviderConfigModal({ onDone }: { onDone: (configured: boolean) => void }): React.JSX.Element {
  const existingConfig = loadConfig();
  const [step, setStep] = useState<ConfigStep>('select');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [inputBuffer, setInputBuffer] = useState('');
  const [savedBaseUrl, setSavedBaseUrl] = useState('');
  const pasteBufRef = useRef('');

  const provider = PROVIDERS[selectedIdx]!;

  const confirmUrl = useCallback(() => {
    const url = inputBuffer.trim() || provider.defaultUrl;
    setSavedBaseUrl(url);
    if (provider.needsKey) {
      const existing = existingConfig.providers[provider.id as ProviderType];
      setInputBuffer(existing?.apiKey || '');
      setStep('key_input');
    } else {
      saveProviderConfig(provider.id, undefined, url);
      onDone(true);
    }
  }, [inputBuffer, provider, existingConfig, onDone]);

  const confirmKey = useCallback(() => {
    const apiKey = inputBuffer.trim() || undefined;
    saveProviderConfig(provider.id, apiKey, savedBaseUrl || provider.defaultUrl);
    onDone(true);
  }, [inputBuffer, provider, savedBaseUrl, onDone]);

  useInput((char, key) => {
    if (step === 'select') {
      if (key.upArrow) { setSelectedIdx(i => (i - 1 + PROVIDERS.length) % PROVIDERS.length); return; }
      if (key.downArrow) { setSelectedIdx(i => (i + 1) % PROVIDERS.length); return; }
      if (key.return) {
        const existing = existingConfig.providers[provider.id as ProviderType];
        setInputBuffer(existing?.baseUrl || '');
        setStep('url_input');
        return;
      }
      if (key.escape) { onDone(false); return; }
      return;
    }

    if (step === 'url_input') {
      if (key.return) { confirmUrl(); return; }
      if (key.escape) { setInputBuffer(''); setStep('select'); return; }
      if (key.backspace || key.delete) { setInputBuffer(p => p.slice(0, -1)); return; }
      if (char && !key.ctrl && !key.meta) { setInputBuffer(p => p + char); return; }
      return;
    }

    if (step === 'key_input') {
      if (key.return) { confirmKey(); return; }
      if (key.escape) {
        setInputBuffer(savedBaseUrl || '');
        setStep('url_input');
        return;
      }
      if (key.backspace || key.delete) { setInputBuffer(p => p.slice(0, -1)); return; }
      // Accept printable chars (including paste chunks)
      if (char && !key.ctrl && !key.meta) { setInputBuffer(p => p + char); return; }
      return;
    }
  });

  if (step === 'select') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <BoxTop title={t('provider.title')} />
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{t('provider.select_hint')}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {PROVIDERS.map((p, i) => {
            const descKey = `provider.desc_${p.id}` as const;
            const isSel = i === selectedIdx;
            return (
              <Text key={p.id}>
                {isSel ? <Text bold color="cyan">  ▸ {p.name}</Text> : <Text>    {p.name}</Text>}
                <Text dimColor> — {t(descKey)}</Text>
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>  [↑/↓] navigate  [Enter] select  [Esc] cancel</Text>
        </Box>
      </Box>
    );
  }

  if (step === 'url_input') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <BoxTop title={t('provider.url_title')} />
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>{t('provider.url_prompt', { name: provider.name })}</Text>
          <Box marginTop={1}>
            <Text dimColor>{t('provider.url_hint')}: </Text>
            <Text color="cyan">{provider.defaultUrl}</Text>
          </Box>
          <Text dimColor>{t('provider.back_hint')}</Text>
          <Box marginTop={1}>
            <Text>  </Text>
            {inputBuffer
              ? <Text color="cyan">{inputBuffer}</Text>
              : <Text dimColor>{t('provider.url_placeholder')}</Text>
            }
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>  [Enter] confirm  [Esc] back</Text>
        </Box>
      </Box>
    );
  }

  // key_input step
  return (
    <Box flexDirection="column" marginBottom={1}>
      <BoxTop title={t('provider.key_title')} />
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{t('provider.key_prompt', { name: provider.name })}</Text>
        <Text dimColor>{t('provider.back_hint')}</Text>
        <Box marginTop={1}>
          <Text>  </Text>
          {inputBuffer
            ? <Text>{'•'.repeat(Math.min(inputBuffer.length, 24))}{inputBuffer.length > 24 ? <Text dimColor> {t('provider.key_chars', { n: inputBuffer.length })}</Text> : null}</Text>
            : <Text dimColor>{t('provider.key_placeholder')}</Text>
          }
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>  [Enter] confirm  [Esc] back</Text>
      </Box>
    </Box>
  );
}

// ─── Ink-based provider config (used by index.ts pre-REPL and /provider) ─

export async function showProviderConfigUI(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const instance = render(
      <ProviderConfigModal onDone={(configured) => {
        instance.unmount();
        resolve(configured);
      }} />
    );
  });
}
