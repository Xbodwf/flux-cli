import React, { useMemo } from 'react';
import { Text } from 'ink';
import hljs from 'highlight.js';
import { parse } from 'node-html-parser';

// ─── Token Type → Color Mapping ─────────────────────────────────────
//
// Maps highlight.js CSS class names to Ink Text color props.
// Uses VS Code Dark+ theme colors for a familiar terminal look.

const TOKEN_COLORS: Record<string, string> = {
  keyword: '#569CD6',
  'keyword-reserved': '#569CD6',
  'keyword-type': '#569CD6',
  string: '#CE9178',
  number: '#B5CEA8',
  comment: '#6A9955',
  built_in: '#4EC9B0',
  literal: '#569CD6',
  'title function': '#DCDCAA',
  'title class': '#DCDCAA',
  'title function_': '#DCDCAA',
  'title class_': '#DCDCAA',
  params: '#D4D4D4',
  attr: '#9CDCFE',
  attribute: '#9CDCFE',
  variable: '#9CDCFE',
  'variable language_': '#9CDCFE',
  punctuation: '#D4D4D4',
  tag: '#569CD6',
  name: '#569CD6',
  type: '#4EC9B0',
  'selector-class': '#D7BA7D',
  'selector-id': '#D7BA7D',
  'selector-tag': '#569CD6',
  regexp: '#B5CEA8',
  symbol: '#B5CEA8',
  'template-variable': '#9CDCFE',
  link: '#569CD6',
  deletion: '#F44747',
  addition: '#4EC9B0',
  meta: '#DCDCAA',
  'meta-keyword': '#569CD6',
  'meta-string': '#CE9178',
  section: '#DCDCAA',
  subst: '#D4D4D4',
  doctag: '#569CD6',
};

export const DEFAULT_COLOR = '#D4D4D4';

// ─── HTML Token Parsing ─────────────────────────────────────────────
//
// highlight.js returns HTML like:
//   '<span class="hljs-keyword">const</span> x = <span class="hljs-number">42</span>'
//
// We parse this into a flat array of { color, bold, text } token objects.

interface HighlightToken {
  color?: string;
  bold?: boolean;
  text: string;
}

function parseHighlightedHtml(html: string): HighlightToken[] {
  const root = parse(html, {
    comment: false,
    blockTextElements: { script: false, style: false, pre: false },
  });

  const tokens: HighlightToken[] = [];

  function walk(node: any, inheritedClass?: string): void {
    if (node.nodeType === 3) {
      // Text node — node-html-parser's .text decodes HTML entities
      const text = node.text;
      if (text) {
        const color = inheritedClass
          ? TOKEN_COLORS[inheritedClass] || DEFAULT_COLOR
          : DEFAULT_COLOR;
        const bold =
          inheritedClass === 'keyword' ||
          inheritedClass?.startsWith('title');
        tokens.push({ text, color, bold: bold || undefined });
      }
      return;
    }

    if (node.nodeType !== 1) return;

    // Element node — extract hljs-* class name
    const classAttr: string = node.getAttribute?.('class') || '';
    const hljsMatch = classAttr.match(/hljs-(\S+)/);
    const currentClass = hljsMatch ? hljsMatch[1] : inheritedClass;

    if (node.childNodes && node.childNodes.length > 0) {
      for (const child of node.childNodes) {
        walk(child, currentClass);
      }
    }
  }

  for (const child of root.childNodes || []) {
    walk(child);
  }

  return collapseTokens(tokens);
}

function collapseTokens(tokens: HighlightToken[]): HighlightToken[] {
  if (tokens.length <= 1) return tokens;
  const result: HighlightToken[] = [];
  let current = tokens[0]!;

  for (let i = 1; i < tokens.length; i++) {
    const next = tokens[i]!;
    if (current.color === next.color && current.bold === next.bold) {
      current = { ...current, text: current.text + next.text };
    } else {
      result.push(current);
      current = next;
    }
  }
  result.push(current);
  return result;
}

// ─── Language Detection ─────────────────────────────────────────────

const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
};

export function resolveLanguage(lang: string): string {
  const resolved = LANG_ALIASES[lang] || lang;
  // Check if highlight.js supports this language
  try {
    const info = hljs.getLanguage(resolved);
    return info ? resolved : '';
  } catch {
    return '';
  }
}

// ─── Shared Highlight Utility ─────────────────────────────────────────

/**
 * Runs highlight.js on the given code and returns parsed token arrays.
 * Falls back to plain DEFAULT_COLOR tokens if language is unsupported.
 */
export function highlightCode(code: string, language: string): HighlightToken[] {
  const lang = resolveLanguage(language);
  if (!lang || !code) return [{ text: code || '', color: DEFAULT_COLOR }];
  try {
    const result = hljs.highlight(code, { language: lang });
    return parseHighlightedHtml(result.value);
  } catch {
    return [{ text: code, color: DEFAULT_COLOR }];
  }
}

/**
 * Highlights full code then splits the highlighted HTML by newline,
 * parsing each line separately. This avoids cross-line token boundary
 * issues that arise when splitting HighlightToken text by newline.
 */
export function highlightCodeByLine(code: string, language: string): HighlightToken[][] {
  const lang = resolveLanguage(language);
  if (!lang || !code) {
    // Plain fallback: split raw code by line
    const lines = code.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.map(line => [{ text: line, color: DEFAULT_COLOR }]);
  }
  try {
    const result = hljs.highlight(code, { language: lang });
    // Split highlighted HTML by newline — each fragment is a self-contained
    // HTML snippet that parseHighlightedHtml can handle independently.
    const htmlLines = result.value.split('\n');
    // Drop trailing empty line from final \n
    if (htmlLines.length > 1 && htmlLines[htmlLines.length - 1] === '') htmlLines.pop();
    return htmlLines.map(lineHtml => parseHighlightedHtml(lineHtml));
  } catch {
    const lines = code.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines.map(line => [{ text: line, color: DEFAULT_COLOR }]);
  }
}

// ─── Highlighted Code Component ─────────────────────────────────────

interface HighlightedCodeProps {
  code: string;
  language: string;
}

/**
 * Renders highlighted code using highlight.js tokens mapped to Ink Text components.
 * Falls back to plain text if the language is not supported.
 */
export function HighlightedCode({ code, language }: HighlightedCodeProps): React.JSX.Element {
  const rendered = useMemo(() => highlightCode(code, language), [code, language]);

  return (
    <Text>
      {rendered.map((token, i) => (
        <Text key={i} color={token.color} bold={token.bold}>
          {token.text}
        </Text>
      ))}
    </Text>
  );
}
