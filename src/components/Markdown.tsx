import { Children, isValidElement, memo, type ReactNode } from 'react';
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

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} onClick={(e) => { e.preventDefault(); if (href) void hub.openExternal(href); }}>{children}</a>
          ),
          // Code-Blöcke: Kopieren-Button erscheint beim Überfahren
          pre: ({ children }) => (
            <div className="group/code relative">
              <pre>{children}</pre>
              <CopyButton className="absolute right-2 top-2 bg-surface/80 opacity-0 transition-opacity group-hover/code:opacity-100" text={() => textOf(children).replace(/\n$/, '')} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
