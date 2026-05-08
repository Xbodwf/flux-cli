import { AgentManager } from '../core/agent-manager.js';
import { t } from '../i18n/index.js';

/**
 * Pipe mode — reads from stdin and processes as a query.
 *
 * Usage:
 *   echo "refactor this" | weave
 *   cat main.ts | weave "review this file"
 *
 * If an argument is provided, it's prepended to stdin content.
 */
export async function handlePipe(
  agentManager: AgentManager,
  queryArg?: string,
): Promise<void> {
  const agent = agentManager.getDefaultAgent();
  if (!agent) {
    console.error(t('index.no_agent'));
    process.exit(1);
  }

  // Read stdin
  const stdin = await readStdin();
  const fullQuery = queryArg
    ? `${queryArg}\n\n---\n${stdin}`
    : stdin;

  if (!fullQuery.trim()) {
    // No input — start REPL instead? No, pipe mode with empty input exits.
    return;
  }

  const message = { role: 'user' as const, content: fullQuery };

  for await (const event of agent.chat([message])) {
    switch (event.type) {
      case 'text_delta':
        process.stdout.write(event.content || '');
        break;
      case 'tool_call':
        // In pipe mode, show tool usage on stderr so stdout stays clean
        process.stderr.write(`\n${t('pipe.tool_call', { name: event.toolCall?.name || '?' })}\n`);
        break;
      case 'error':
        process.stderr.write(`\n${t('pipe.error', { content: event.content })}\n`);
        break;
    }
  }

  process.stdout.write('\n');
}

/**
 * Read all of stdin into a string.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(Buffer.from(chunk));
    });

    process.stdin.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    process.stdin.on('error', reject);
  });
}
