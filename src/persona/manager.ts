import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { homedir } from 'node:os';
import type { Persona } from '../core/types.js';

const BUILTIN_PERSONAS_DIR = new URL('./builtin/', import.meta.url).pathname;
const CUSTOM_PERSONAS_DIR = join(homedir(), '.flux_conf', 'personas');

/**
 * PersonaManager — loads and manages agent personalities.
 *
 * Loads from two sources:
 * 1. Built-in personas shipped with Flux (src/persona/builtin/)
 * 2. Custom personas from ~/.flux_conf/personas/
 *
 * Custom personas override built-in ones with the same name.
 */
export class PersonaManager {
  private cache = new Map<string, Persona>();
  private loaded = false;

  /**
   * Load all personas (built-in + custom).
   */
  async loadAll(): Promise<Map<string, Persona>> {
    const personas = new Map<string, Persona>();

    // Load built-in personas
    if (existsSync(BUILTIN_PERSONAS_DIR)) {
      const files = readdirSync(BUILTIN_PERSONAS_DIR);
      for (const file of files) {
        if (extname(file) !== '.yaml' && extname(file) !== '.yml') continue;
        const raw = readFileSync(join(BUILTIN_PERSONAS_DIR, file), 'utf-8');
        const persona = parseYaml(raw) as Persona;
        if (persona?.name) {
          personas.set(persona.name, persona);
        }
      }
    }

    // Load custom personas (override built-in)
    if (existsSync(CUSTOM_PERSONAS_DIR)) {
      const files = readdirSync(CUSTOM_PERSONAS_DIR);
      for (const file of files) {
        if (extname(file) !== '.yaml' && extname(file) !== '.yml') continue;
        const raw = readFileSync(join(CUSTOM_PERSONAS_DIR, file), 'utf-8');
        const persona = parseYaml(raw) as Persona;
        if (persona?.name) {
          personas.set(persona.name, persona);
        }
      }
    }

    this.cache = personas;
    this.loaded = true;
    return personas;
  }

  /**
   * Get a persona by name.
   */
  get(name: string): Persona | undefined {
    if (!this.loaded) {
      // Attempt load on demand
      this.loadAll().catch(() => {});
    }
    return this.cache.get(name);
  }

  /**
   * List all available personas.
   */
  list(): Persona[] {
    return Array.from(this.cache.values());
  }

  /**
   * Get the default persona.
   */
  getDefault(): Persona {
    return this.get('default') || {
      name: 'default',
      description: 'Default persona',
      prompt: 'You are a helpful AI assistant.',
    };
  }

  /**
   * Reload personas from disk.
   */
  async reload(): Promise<void> {
    this.cache.clear();
    this.loaded = false;
    await this.loadAll();
  }
}
