import { Children, isValidElement, memo, useMemo, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { hub } from '@/lib/api';
import { CopyButton } from './ui';

function textOf(n: ReactNode): string {
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  if (Array.isArray(n)) return n.map(textOf).join('');
  if (isValidElement(n)) return Children.toArray((n.props as { children?: ReactNode }).children).map(textOf).join('');
  return '';
}

/** Teilt langen Text an Leerzeilen außerhalb von Code-Blöcken. Listen, Zitate, Tabellen und eingerückte Fortsetzungen bleiben beim Vorgänger. */
function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence = '';
  let blank = false;
  const continuation = /^(\s{2,}|\t|[-*+]\s|\d+[.)]\s|>|\||```|~~~)/;
  for (const line of text.split('\n')) {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line)?.[1];
    if (f) { if (!fence) fence = f[0]; else if (f[0] === fence) fence = ''; }
    if (!fence && blank && line.trim() && cur.length && !continuation.test(line)) { blocks.push(cur.join('\n')); cur = []; }
    blank = !fence && !line.trim();
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join('\n'));
  return blocks;
}

const components = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); if (href) void hub.openExternal(href); }}>{children}</a>
  ),
  // Code-Blöcke: Kopieren-Button erscheint beim Überfahren
  pre: ({ children }: { children?: ReactNode }) => (
    <div className="group/code relative">
      <pre>{children}</pre>
      <CopyButton className="absolute right-2 top-2 bg-surface/80 opacity-0 transition-opacity group-hover/code:opacity-100" text={() => textOf(children).replace(/\n$/, '')} />
    </div>
  ),
};

const Chunk = memo(function Chunk({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>;
});

/** Lange, wachsende Antworten: nur der letzte Abschnitt wird beim Streamen neu geparst, fertige Abschnitte bleiben unverändert. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => (text.length > 1500 ? splitBlocks(text) : [text]), [text]);
  return (
    <div className="md select-text">
      {blocks.map((b, i) => <Chunk key={i} text={b} />)}
    </div>
  );
});
