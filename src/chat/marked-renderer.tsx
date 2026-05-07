import React, { useMemo } from 'react';
import { Text, Box } from 'ink';
import { marked } from 'marked';
import type { Token, Tokens, TokensList } from 'marked';
import { terminalWidth } from '../cli/ansi.js';
import { highlightCodeByLine, DEFAULT_COLOR } from '../cli/syntax-highlight.js';

// ─── Configuration ─────────────────────────────────────────────────

const MAX_CODE_WIDTH = Math.min(terminalWidth(), 80);
interface RenderOptions { tokens: TokensList }

// ─── Inline Rendering ──────────────────────────────────────────────

function renderInline(tokens: Token[]): React.ReactNode[] {
  return tokens.map((token, i) => {
    switch (token.type) {
      case 'strong':
        return <Text key={i} bold>{renderInline((token as Tokens.Strong).tokens)}</Text>;
      case 'em':
        return <Text key={i} italic>{renderInline((token as Tokens.Em).tokens)}</Text>;
      case 'codespan':
        return <Text key={i} color="#CE9178" backgroundColor="#1E1E20">{` ${(token as Tokens.Codespan).text} `}</Text>;
      case 'link':
        return (
          <React.Fragment key={i}>
            <Text underline color="#569CD6">{(token as Tokens.Link).text}</Text>
            <Text dimColor> ({(token as Tokens.Link).href})</Text>
          </React.Fragment>
        );
      case 'br':
        return <React.Fragment key={i}><Text>{'\n'}</Text></React.Fragment>;
      case 'del':
        return <Text key={i} dimColor>{renderInline((token as Tokens.Del).tokens)}</Text>;
      case 'text':
        return <React.Fragment key={i}>{renderTextToken(token as Tokens.Text)}</React.Fragment>;
      case 'image':
        return <Text key={i} dimColor>[image: {(token as Tokens.Image).text}]</Text>;
      case 'escape':
        return <React.Fragment key={i}>{(token as Tokens.Escape).text}</React.Fragment>;
      default:
        return <Text key={i}>{(token as any).text || ''}</Text>;
    }
  });
}

function renderTextToken(token: Tokens.Text): React.ReactNode {
  if ('tokens' in token && token.tokens) {
    return renderInline(token.tokens);
  }
  return <>{token.text}</>;
}

function renderInlineOrText(tokens: Token[] | undefined, text: string): React.ReactNode {
  if (tokens && tokens.length > 0) {
    return renderInline(tokens);
  }
  return <>{text}</>;
}

// ─── Block Rendering ───────────────────────────────────────────────

function Heading({ token }: { token: Tokens.Heading }): React.JSX.Element {
  const content = renderInlineOrText(token.tokens, token.text);
  switch (token.depth) {
    case 1:
      return (
        <Box flexDirection="column">
          <Text bold color="#569CD6">{content}</Text>
          <Text dimColor>{'━'.repeat(Math.min((token.text?.length || 2) + 2, MAX_CODE_WIDTH))}</Text>
        </Box>
      );
    case 2:
      return <Text bold color="#4EC9B0">{'## '}{content}</Text>;
    case 3:
      return <Text bold color="#CE9178">{'### '}{content}</Text>;
    default:
      return <Text bold dimColor>{'#'.repeat(token.depth)}{' '}{content}</Text>;
  }
}

function Paragraph({ token }: { token: Tokens.Paragraph }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text>{renderInlineOrText(token.tokens, token.text)}</Text>
    </Box>
  );
}

function CodeBlock({ token }: { token: Tokens.Code }): React.JSX.Element {
  const code = token.text || '';
  const lang = token.lang || '';
  const width = MAX_CODE_WIDTH;

  const lines = useMemo(() => {
    if (!code) return [];
    return highlightCodeByLine(code, lang);
  }, [code, lang]);

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{'┌' + '─'.repeat(width - 2) + '┐'}</Text>
        {lang && <Text dimColor> {lang}</Text>}
      </Box>
      {lines.map((tokens, i) => (
        <Box key={i} backgroundColor="#1E1E20">
          <Text>
            <Text dimColor>{' │ '}</Text>
            {tokens.map((t, j) => (
              <Text key={j} color={t.color} bold={t.bold ?? false}>
                {t.text || ' '}
              </Text>
            ))}
            <Text dimColor>
              {' '.repeat(Math.max(0, width - 4 - (tokens.map(t => t.text).join('').length)))} │
            </Text>
          </Text>
        </Box>
      ))}
      <Text dimColor>{'└' + '─'.repeat(width - 2) + '┘'}</Text>
    </Box>
  );
}

function ListBlock({ token }: { token: Tokens.List }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => (
        <ListItem key={i} token={item} index={i} isOrdered={token.ordered} />
      ))}
    </Box>
  );
}

function ListItem({ token, index, isOrdered }: {
  token: Tokens.ListItem; index: number; isOrdered: boolean;
}): React.JSX.Element {
  const bullet = isOrdered ? `${index + 1}.` : '•';
  const content = renderInlineOrText(token.tokens, token.text);

  // Check if list item has nested tasks/items
  if (token.tokens && token.tokens.some(t => t.type === 'list')) {
    const mainTokens = token.tokens.filter(t => t.type !== 'list');
    const nestedList = token.tokens.find(t => t.type === 'list');
    return (
      <Box flexDirection="column">
        <Text>
          <Text dimColor>{bullet} </Text>
          {mainTokens.length > 0 ? renderInline(mainTokens) : content}
        </Text>
        {nestedList && <ListBlock token={nestedList as Tokens.List} />}
      </Box>
    );
  }

  return (
    <Text>
      <Text dimColor>{bullet} </Text>
      {content}
    </Text>
  );
}

function BlockquoteBlock({ token }: { token: Tokens.Blockquote }): React.JSX.Element {
  const content = renderInlineOrText(token.tokens, token.text);
  return (
    <Box>
      <Text dimColor>│ </Text>
      <Text italic>{content}</Text>
    </Box>
  );
}

function TableBlock({ token }: { token: Tokens.Table }): React.JSX.Element {
  const headerCells = token.header.map((h, i) => {
    const align = token.align[i] || '';
    const text = renderInlineOrText(h.tokens, h.text);
    return <Text key={i} bold>{text}</Text>;
  });

  const rows = token.rows.map((row, ri) => (
    <Box key={ri}>
      {row.map((cell, ci) => {
        const content = renderInlineOrText(cell.tokens, cell.text);
        return (
          <React.Fragment key={ci}>
            {ci > 0 && <Text dimColor> │ </Text>}
            <Text>{content}</Text>
          </React.Fragment>
        );
      })}
    </Box>
  ));

  return (
    <Box flexDirection="column">
      <Box><Text dimColor>│ </Text>{headerCells}</Box>
      <Text dimColor>{'├' + '─'.repeat(40) + '┤'}</Text>
      {rows.map((row, i) => (
        <Box key={i}><Text dimColor>│ </Text>{row}</Box>
      ))}
    </Box>
  );
}

function HorizontalRule(): React.JSX.Element {
  return <Text dimColor>{'─'.repeat(Math.min(terminalWidth(), 60))}</Text>;
}

// ─── Top-Level Markdown Renderer ───────────────────────────────────

/**
 * Render a complete markdown text block as Ink components.
 * Uses marked.js to parse, then maps tokens to Ink renderers.
 */
export function MarkdownBlock({ content }: { content: string }): React.JSX.Element {
  if (!content || !content.trim()) return <Text> </Text>;

  const tokens = marked.lexer(content, { gfm: true });

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => {
        switch (token.type) {
          case 'heading':
            return <Heading key={i} token={token as Tokens.Heading} />;
          case 'paragraph':
            return <Paragraph key={i} token={token as Tokens.Paragraph} />;
          case 'code':
            return <CodeBlock key={i} token={token as Tokens.Code} />;
          case 'list':
            return <ListBlock key={i} token={token as Tokens.List} />;
          case 'blockquote':
            return <BlockquoteBlock key={i} token={token as Tokens.Blockquote} />;
          case 'table':
            return <TableBlock key={i} token={token as Tokens.Table} />;
          case 'hr':
            return <HorizontalRule key={i} />;
          case 'space':
            return <Text key={i}> </Text>;
          default:
            return <Text key={i}>{(token as any).text || ''}</Text>;
        }
      })}
    </Box>
  );
}
