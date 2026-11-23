/**
 * "Notices & attribution" from the footer: the repository's NOTICE.md (licences of Outpost, the
 * Lichess code and assets it reuses, and the data sources), bundled at build time as text in its
 * own chunk and rendered with a tiny Markdown subset (headings, paragraphs, nested lists, bold,
 * code, links).
 *
 * NOTICE.md is a required build input: the import below fails the build when it is missing (the
 * Docker build stage copies it next to `web/` for this), so no build ships without the
 * attributions that CC BY-SA data and the piece-set licences ask for.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ErrorBox, Spinner } from '../../../components/index.ts';
import { Modal } from './Dialog.tsx';
import './account.css';

/** Loads NOTICE.md (a separate chunk, fetched when the dialog opens). */
export async function loadNotice(): Promise<string> {
  return (await import('../../../../../../NOTICE.md?raw')).default;
}

export function NoticeDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    // The chunk can fail to load (offline, or a redeploy replaced it).
    loadNotice().then(
      t => live && setText(t),
      e => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  // The first heading is the dialog title.
  const body = text?.replace(/^#\s+[^\n]*\n+/, '') ?? null;
  return (
    <Modal title="Notices and attribution" onClose={onClose} wide>
      {body !== null ? (
        <div className="acc-markdown">{renderMarkdown(body)}</div>
      ) : error ? (
        <ErrorBox error={error} title="Could not load the notices" onRetry={() => setAttempt(a => a + 1)} />
      ) : (
        <Spinner center />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Markdown subset
// ---------------------------------------------------------------------------

interface ListNode {
  text: string;
  children: ListNode[];
}

/** Inline Markdown: `code`, **bold**, [text](url) and bare http(s) URLs. */
export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>,]+[^\s)<>,.;:])/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) out.push(<code key={key}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={key}>{renderInline(m[2], key)}</strong>);
    else if (m[3] !== undefined && m[4] !== undefined)
      out.push(
        <a key={key} href={m[4]} target="_blank" rel="noreferrer noopener">
          {m[3]}
        </a>,
      );
    else if (m[5] !== undefined)
      out.push(
        <a key={key} href={m[5]} target="_blank" rel="noreferrer noopener">
          {m[5]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Block Markdown: `#`–`####` headings, paragraphs, and `-`/`*` lists nested by indentation. */
export function renderMarkdown(md: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let para: string[] = [];
  let list: ListNode[] | null = null;
  // Stack of [indent, node list] for the list being built.
  let stack: Array<{ indent: number; items: ListNode[] }> = [];
  let k = 0;

  const flushPara = () => {
    if (para.length) {
      const key = `p${k++}`;
      blocks.push(<p key={key}>{renderInline(para.join(' '), key)}</p>);
    }
    para = [];
  };
  const flushList = () => {
    if (list) {
      const key = `l${k++}`;
      blocks.push(renderList(list, key));
    }
    list = null;
    stack = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line === '') {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(4, heading[1]!.length + 1);
      const H = `h${level}` as 'h2' | 'h3' | 'h4';
      const key = `h${k++}`;
      blocks.push(<H key={key}>{renderInline(heading[2]!, key)}</H>);
      continue;
    }
    const item = /^(\s*)[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushPara();
      const indent = item[1]!.length;
      const node: ListNode = { text: item[2]!, children: [] };
      if (!list) {
        list = [];
        stack = [{ indent, items: list }];
      }
      while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
      const top = stack[stack.length - 1]!;
      if (indent > top.indent && top.items.length) {
        const parent = top.items[top.items.length - 1]!;
        stack.push({ indent, items: parent.children });
        parent.children.push(node);
      } else top.items.push(node);
      continue;
    }
    if (list && /^\s+\S/.test(line)) {
      // Continuation of the last list item.
      const items = stack[stack.length - 1]!.items;
      const lastItem = items[items.length - 1];
      if (lastItem) lastItem.text += ` ${line.trim()}`;
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

function renderList(items: ListNode[], key: string): ReactNode {
  return (
    <ul key={key}>
      {items.map((it, i) => {
        const k = `${key}-${i}`;
        return (
          <li key={k}>
            {renderInline(it.text, k)}
            {it.children.length > 0 && renderList(it.children, `${k}c`)}
          </li>
        );
      })}
    </ul>
  );
}
