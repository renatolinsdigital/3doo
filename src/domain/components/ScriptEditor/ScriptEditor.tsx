import {
  type KeyboardEvent,
  type MouseEvent,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AUTOFOCUS, OWNS_ESCAPE } from '@shared/components';
import { cx } from '@shared/utils/cx';

import { type ApiEntry, NAMESPACES, apiEntry, docsHref } from '../../scripting/reference';
import {
  type Completion,
  completionContext,
  completions,
  lineAt,
  toLines,
  tokenize,
} from '../../scripting/syntax';

import './ScriptEditor.scss';

const INDENT = '  ';
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const QUOTES = new Set(["'", '"', '`']);
const CLOSERS = new Set([')', ']', '}']);
const WORD = /[\w$]/;

/** How long the pointer rests on a name before its balloon opens, and lingers after. */
const HOVER_DELAY_MS = 350;
const HOVER_GRACE_MS = 220;

/**
 * Past this many characters the text is drawn without colour, one span a line
 * rather than one a token. A dense mesh written out point by point runs to
 * hundreds of thousands of tokens, and a span for each would stall the page.
 */
export const HIGHLIGHT_LIMIT = 100_000;

export interface ScriptEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Ctrl+Enter, or Cmd+Enter on a Mac. */
  onRun?: () => void;
  /**
   * Shows the code without letting it be edited. It can still be selected and
   * copied, and its names still open their reference on hover.
   */
  readOnly?: boolean;
  /** Takes the focus as its dialog opens. Off for one that opens hidden behind another. */
  autoFocus?: boolean;
  /** Line to mark as the one that failed, counted from 1. */
  errorLine?: number | null;
  /** Changes on every failed run, so the same line failing twice still takes the caret there. */
  errorKey?: number;
  label: string;
}

export interface ScriptEditorHandle {
  /** Swaps the whole text for another, as one step Ctrl+Z can take back. */
  replaceAll: (text: string) => void;
}

interface CompletionState {
  items: Completion[];
  index: number;
  from: number;
}

interface HoverState {
  entries: ApiEntry[];
  /** The name's box in the window, which the balloon hangs off. */
  left: number;
  top: number;
  bottom: number;
}

/**
 * A code editor made of a textarea laid over the highlighted text.
 *
 * The textarea does the typing, the caret, the selection and the undo, and is
 * transparent; underneath it the same text is drawn again in colour, line by
 * line, and moved with every scroll so the two stay in register. Keeping the
 * browser's own field for the input is what keeps everything people expect
 * from one: native undo, IME composition, spell-free paste, screen readers.
 *
 * Everything that edits the text on the user's behalf (indenting, closing a
 * bracket, accepting a suggestion) goes through `insertText`, so one Ctrl+Z
 * takes back exactly what one keystroke did.
 */
export const ScriptEditor = forwardRef<ScriptEditorHandle, ScriptEditorProps>(function ScriptEditor(
  {
    value,
    onChange,
    onRun,
    readOnly = false,
    autoFocus = true,
    errorLine = null,
    errorKey = 0,
    label,
  },
  ref,
) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const balloon = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const metrics = useRef({ char: 7.2, line: 18 });
  const programmatic = useRef(false);
  const hoveredName = useRef<HTMLElement | null>(null);
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);

  const [caret, setCaret] = useState(0);
  const [completion, setCompletion] = useState<CompletionState | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const tokens = useMemo(
    () =>
      value.length > HIGHLIGHT_LIMIT
        ? [{ kind: 'identifier' as const, text: value, start: 0 }]
        : tokenize(value),
    [value],
  );
  const lines = useMemo(() => toLines(tokens), [tokens]);
  const caretLine = useMemo(() => lineAt(value, caret), [value, caret]);
  const caretColumn = caret - (value.lastIndexOf('\n', caret - 1) + 1) + 1;

  // The API name the caret sits in, for the status line: the keyboard's way
  // to what the pointer gets from the balloon.
  const caretEntry = useMemo(() => {
    const token = tokens.find(
      (candidate) =>
        candidate.entries &&
        candidate.start <= caret &&
        caret <= candidate.start + candidate.text.length,
    );
    return token?.entries?.[0] ?? null;
  }, [tokens, caret]);

  const remeasure = useCallback(() => {
    const span = measure.current;
    const line = layer.current?.querySelector<HTMLElement>('.script-editor__line');
    if (span && span.getBoundingClientRect().width > 0) {
      metrics.current.char =
        span.getBoundingClientRect().width / Math.max(1, span.textContent?.length ?? 1);
    }
    if (line && line.getBoundingClientRect().height > 0) {
      metrics.current.line = line.getBoundingClientRect().height;
    }
  }, []);

  useLayoutEffect(() => {
    remeasure();
    // The code font arrives from the network, and until it does the fallback
    // draws at another width.
    void document.fonts?.ready.then(remeasure);
  }, [remeasure]);

  useEffect(
    () => () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
    },
    [],
  );

  const closeHover = useCallback(() => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hoveredName.current?.classList.remove('script-editor__token--hovered');
    hoveredName.current = null;
    setHover(null);
  }, []);

  // A failed run puts the caret on the line that failed, scrolled into view.
  useEffect(() => {
    const field = textarea.current;
    if (!field || errorLine === null || errorKey === 0) return;
    const starts = [0];
    for (let i = 0; i < field.value.length; i++) if (field.value[i] === '\n') starts.push(i + 1);
    const start = starts[errorLine - 1];
    if (start === undefined) return;
    const indent = /^[ \t]*/.exec(field.value.slice(start))?.[0].length ?? 0;
    field.focus();
    field.setSelectionRange(start + indent, start + indent);
    setCaret(start + indent);

    const top = (errorLine - 1) * metrics.current.line;
    if (
      top < field.scrollTop ||
      top > field.scrollTop + field.clientHeight - metrics.current.line * 2
    ) {
      field.scrollTop = Math.max(0, top - field.clientHeight / 3);
    }
  }, [errorLine, errorKey]);

  /**
   * Replaces part of the text the way typing would, so Ctrl+Z takes it back.
   *
   * `insertText` is what puts an edit on the field's own undo stack; a value
   * written from script goes around it. Where the command is missing the text
   * is still changed, only without the undo.
   */
  const replace = useCallback(
    (start: number, end: number, text: string, selection: [number, number]) => {
      const field = textarea.current;
      if (!field) return;
      programmatic.current = true;
      field.focus();
      field.setSelectionRange(start, end);

      let done = false;
      try {
        if (text !== '') done = document.execCommand('insertText', false, text);
        else if (start !== end) done = document.execCommand('delete');
        else done = true;
      } catch {
        done = false;
      }
      if (!done) {
        field.setRangeText(text, start, end, 'end');
        onChange?.(field.value);
      }

      programmatic.current = false;
      field.setSelectionRange(selection[0], selection[1]);
      setCaret(selection[1]);
    },
    [onChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      replaceAll: (text) => {
        const length = textarea.current?.value.length ?? 0;
        replace(0, length, text, [0, 0]);
        if (textarea.current) textarea.current.scrollTop = 0;
      },
    }),
    [replace],
  );

  const refreshCompletion = useCallback((text: string, at: number, force: boolean) => {
    const context = completionContext(text, at);
    const namespaceDot =
      context?.prefix === '' && (context.receiver === 'scene' || context.receiver === 'view');
    if (!context || (!force && context.prefix === '' && !namespaceDot)) {
      setCompletion(null);
      return;
    }
    const items = completions(context);
    setCompletion(items.length > 0 ? { items, index: 0, from: context.from } : null);
  }, []);

  const accept = (item: Completion) => {
    const field = textarea.current;
    if (!field || !completion) return;
    const end = field.selectionStart;
    const call = item.entries[0]?.kind === 'function' && field.value[end] !== '(';
    const text = call ? `${item.name}()` : item.name;
    const at = completion.from + item.name.length + (call ? 1 : 0);
    setCompletion(null);
    replace(completion.from, end, text, [at, at]);
  };

  /** The whole lines a selection touches, as offsets: where the first starts and the last ends. */
  const selectedLines = (field: HTMLTextAreaElement) => {
    const text = field.value;
    const first = text.lastIndexOf('\n', field.selectionStart - 1) + 1;
    const lastEnd =
      field.selectionEnd > field.selectionStart && text[field.selectionEnd - 1] === '\n'
        ? field.selectionEnd - 1
        : field.selectionEnd;
    const nextBreak = text.indexOf('\n', lastEnd);
    return { first, end: nextBreak === -1 ? text.length : nextBreak };
  };

  const shiftLines = (field: HTMLTextAreaElement, outdent: boolean) => {
    const { first, end } = selectedLines(field);
    const block = field.value.slice(first, end).split('\n');
    const shifted = block.map((line) =>
      outdent ? line.replace(/^ {1,2}/, '') : line === '' ? line : INDENT + line,
    );
    const changeOfFirst = shifted[0].length - block[0].length;
    const total = shifted.join('\n');
    const start = Math.max(first, field.selectionStart + changeOfFirst);
    replace(first, end, total, [start, field.selectionEnd + (total.length - (end - first))]);
  };

  const toggleComment = (field: HTMLTextAreaElement) => {
    const { first, end } = selectedLines(field);
    const block = field.value.slice(first, end).split('\n');
    const filled = block.filter((line) => line.trim() !== '');
    const commented = filled.length > 0 && filled.every((line) => /^\s*\/\//.test(line));
    const margin = Math.min(...filled.map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
    const next = block.map((line) => {
      if (line.trim() === '') return line;
      if (commented) return line.replace(/^(\s*)\/\/ ?/, '$1');
      return `${line.slice(0, margin)}// ${line.slice(margin)}`;
    });
    const total = next.join('\n');
    const caretAt = Math.max(first, field.selectionEnd + (total.length - (end - first)));
    replace(first, end, total, [
      field.selectionStart === field.selectionEnd ? caretAt : first,
      caretAt,
    ]);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    const { selectionStart: start, selectionEnd: end, value: text } = field;
    const mod = event.ctrlKey || event.metaKey;

    if (completion) {
      const count = completion.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setCompletion({ ...completion, index: (completion.index + step + count) % count });
        return;
      }
      if ((event.key === 'Enter' && !mod) || event.key === 'Tab') {
        event.preventDefault();
        accept(completion.items[completion.index]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCompletion(null);
        return;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (hover) {
        closeHover();
        return;
      }
      // Out of the editor, so Tab moves between the controls again and the
      // next Escape closes the dialog.
      field.blur();
      field.closest<HTMLElement>('[role="dialog"]')?.focus();
      return;
    }

    // The field refuses typing itself; everything below edits the text for it.
    if (readOnly) return;

    if (mod && event.key === 'Enter') {
      event.preventDefault();
      setCompletion(null);
      onRun?.();
      return;
    }

    if (mod && (event.key === ' ' || event.code === 'Space')) {
      event.preventDefault();
      refreshCompletion(text, start, true);
      return;
    }

    if (mod && (event.key === '/' || event.code === 'Slash')) {
      event.preventDefault();
      toggleComment(field);
      return;
    }

    if (event.key === 'Tab' && !mod && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey || start !== end) {
        shiftLines(field, event.shiftKey);
      } else {
        replace(start, end, INDENT, [start + INDENT.length, start + INDENT.length]);
      }
      return;
    }

    if (mod || event.altKey) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const indent = /^[ \t]*/.exec(text.slice(lineStart, start))?.[0] ?? '';
      const opener = text.slice(lineStart, start).trimEnd().slice(-1);
      if (OPENERS[opener]) {
        const inner = `\n${indent}${INDENT}`;
        const wrap = text[end] === OPENERS[opener] ? `${inner}\n${indent}` : inner;
        const at = start + inner.length;
        replace(start, end, wrap, [at, at]);
      } else {
        const at = start + 1 + indent.length;
        replace(start, end, `\n${indent}`, [at, at]);
      }
      return;
    }

    if (event.key === 'Backspace' && start === end && start > 0) {
      const before = text[start - 1];
      if ((OPENERS[before] ?? (QUOTES.has(before) ? before : null)) === text[start]) {
        event.preventDefault();
        replace(start - 1, start + 1, '', [start - 1, start - 1]);
        return;
      }
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const leading = text.slice(lineStart, start);
      if (leading.length >= INDENT.length && /^ +$/.test(leading)) {
        event.preventDefault();
        const back = leading.length % INDENT.length || INDENT.length;
        replace(start - back, start, '', [start - back, start - back]);
      }
      return;
    }

    const key = event.key;
    if (key.length !== 1) return;

    // Typing the closer the editor already put there steps over it.
    if ((CLOSERS.has(key) || QUOTES.has(key)) && start === end && text[start] === key) {
      event.preventDefault();
      field.setSelectionRange(start + 1, start + 1);
      setCaret(start + 1);
      return;
    }

    const closer = OPENERS[key] ?? (QUOTES.has(key) ? key : null);
    if (!closer) return;

    if (start !== end) {
      event.preventDefault();
      replace(start, end, `${key}${text.slice(start, end)}${closer}`, [start + 1, end + 1]);
      return;
    }

    const next = text[start];
    const previous = text[start - 1];
    const openSpace = next === undefined || /[\s)\]};,]/.test(next);
    // A quote straight after a word is an apostrophe or the end of a string,
    // never the start of one.
    const quoteAfterWord = QUOTES.has(key) && previous !== undefined && WORD.test(previous);
    if (openSpace && !quoteAfterWord) {
      event.preventDefault();
      replace(start, end, `${key}${closer}`, [start + 1, start + 1]);
    }
  };

  const handleChange = (next: string, at: number) => {
    onChange?.(next);
    setCaret(at);
    closeHover();
    if (programmatic.current) return;

    const typed = next.length === value.length + 1 && WORD.test(next[at - 1] ?? '');
    const dot = next.length === value.length + 1 && next[at - 1] === '.';
    if (typed || dot || (completion && next.length < value.length))
      refreshCompletion(next, at, false);
    else setCompletion(null);
  };

  const handleScroll = () => {
    const field = textarea.current;
    if (!field) return;
    if (layer.current) {
      layer.current.style.transform = `translate(${-field.scrollLeft}px, ${-field.scrollTop}px)`;
    }
    if (gutter.current) gutter.current.style.transform = `translateY(${-field.scrollTop}px)`;
    setCompletion(null);
    closeHover();
  };

  /** The highlighted API name under a point in the window, if there is one. */
  const nameAt = (x: number, y: number): HTMLElement | null => {
    if (typeof document.elementsFromPoint !== 'function') return null;
    for (const element of document.elementsFromPoint(x, y)) {
      if (
        element instanceof HTMLElement &&
        element.dataset.api &&
        layer.current?.contains(element)
      ) {
        return element;
      }
    }
    return null;
  };

  const scheduleHide = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(closeHover, HOVER_GRACE_MS);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    if (event.buttons !== 0) return;
    if (balloon.current?.contains(event.target as Node)) return;

    const name = nameAt(event.clientX, event.clientY);
    if (name === hoveredName.current) {
      if (name) window.clearTimeout(hideTimer.current);
      return;
    }

    hoveredName.current?.classList.remove('script-editor__token--hovered');
    hoveredName.current = name;
    if (!name) {
      scheduleHide();
      return;
    }

    name.classList.add('script-editor__token--hovered');
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    showTimer.current = window.setTimeout(() => {
      const entries = (name.dataset.api ?? '')
        .split(' ')
        .map((id) => apiEntry(id))
        .filter((entry): entry is ApiEntry => entry !== undefined);
      const rect = name.getBoundingClientRect();
      if (entries.length > 0)
        setHover({ entries, left: rect.left, top: rect.top, bottom: rect.bottom });
    }, HOVER_DELAY_MS);
  };

  // Placed once it is in the page, so it can flip above the name near the
  // bottom of the window and stay clear of its right edge.
  useLayoutEffect(() => {
    const node = balloon.current;
    if (!node || !hover) return;
    const { width, height } = node.getBoundingClientRect();
    const below = hover.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? hover.top - height - 6 : below;
    node.style.left = `${Math.max(8, Math.min(hover.left, window.innerWidth - width - 8))}px`;
    node.style.top = `${Math.max(8, top)}px`;
    node.style.visibility = 'visible';
  }, [hover]);

  // The suggestion list hangs under the word being typed.
  useLayoutEffect(() => {
    const node = list.current;
    const field = textarea.current;
    if (!node || !field || !completion) return;
    const before = field.value.slice(0, completion.from);
    const row = before.split('\n').length - 1;
    const column = completion.from - (before.lastIndexOf('\n') + 1);
    const box = field.getBoundingClientRect();
    const style = window.getComputedStyle(field);
    const left =
      box.left +
      parseFloat(style.paddingLeft || '0') +
      column * metrics.current.char -
      field.scrollLeft;
    const lineTop =
      box.top + parseFloat(style.paddingTop || '0') + row * metrics.current.line - field.scrollTop;
    const { width, height } = node.getBoundingClientRect();
    const below = lineTop + metrics.current.line + 2;
    const top = below + height > window.innerHeight - 8 ? lineTop - height - 2 : below;
    node.style.left = `${Math.max(8, Math.min(left - 4, window.innerWidth - width - 8))}px`;
    node.style.top = `${Math.max(8, top)}px`;
    node.style.visibility = 'visible';
    node.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [completion]);

  const selected = completion?.items[completion.index];

  return (
    <div className="script-editor">
      <div className="script-editor__frame">
        <div className="script-editor__gutter" aria-hidden="true">
          <div className="script-editor__numbers" ref={gutter}>
            {lines.map((_, index) => (
              <div
                key={index}
                className={cx(
                  'script-editor__number',
                  index + 1 === caretLine && 'script-editor__number--current',
                  index + 1 === errorLine && 'script-editor__number--error',
                )}
              >
                {index + 1}
              </div>
            ))}
          </div>
        </div>

        <div
          className="script-editor__code"
          onMouseMove={handleMouseMove}
          onMouseLeave={scheduleHide}
        >
          <div className="script-editor__layer" ref={layer} aria-hidden="true">
            <span className="script-editor__measure" ref={measure}>
              0000000000
            </span>
            {lines.map((line, index) => (
              <div
                key={index}
                className={cx(
                  'script-editor__line',
                  index + 1 === caretLine && 'script-editor__line--current',
                  index + 1 === errorLine && 'script-editor__line--error',
                )}
              >
                {line.map((token, at) => (
                  <span
                    key={at}
                    className={`script-editor__token script-editor__token--${token.kind}`}
                    data-api={token.entries?.map((entry) => entry.id).join(' ')}
                  >
                    {token.text}
                  </span>
                ))}
              </div>
            ))}
          </div>

          <textarea
            ref={textarea}
            className="script-editor__input"
            aria-label={label}
            value={value}
            readOnly={readOnly}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            {...{ [OWNS_ESCAPE]: '', ...(autoFocus ? { [AUTOFOCUS]: '' } : {}) }}
            onChange={(event) => handleChange(event.target.value, event.target.selectionStart)}
            onKeyDown={handleKeyDown}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onScroll={handleScroll}
            onBlur={() => setCompletion(null)}
          />

          {completion && (
            <ul
              ref={list}
              className="script-editor__completions"
              role="listbox"
              aria-label="Suggestions"
              style={{ visibility: 'hidden' }}
            >
              {completion.items.map((item, index) => (
                <li
                  key={item.name}
                  role="option"
                  aria-selected={index === completion.index}
                  className="script-editor__completion"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(item);
                  }}
                >
                  <span className="script-editor__completion-name">{item.name}</span>
                  <span className="script-editor__completion-owner">
                    {[
                      ...new Set(
                        item.entries.map((entry) =>
                          NAMESPACES.has(entry.owner) ? entry.kind : entry.owner,
                        ),
                      ),
                    ].join(' · ')}
                  </span>
                </li>
              ))}
              {selected && (
                <li className="script-editor__completion-detail" aria-hidden="true">
                  <code>{selected.entries[0].signature}</code>
                  <span>{selected.entries[0].summary}</span>
                </li>
              )}
            </ul>
          )}

          {hover && (
            <div
              ref={balloon}
              className="script-editor__balloon"
              role="tooltip"
              style={{ visibility: 'hidden' }}
              onMouseEnter={() => window.clearTimeout(hideTimer.current)}
              onMouseLeave={scheduleHide}
            >
              {hover.entries.map((entry) => (
                <div key={entry.id} className="script-editor__entry">
                  <code className="script-editor__signature">{entry.signature}</code>
                  <p className="script-editor__summary">{entry.summary}</p>
                  <a
                    className="script-editor__docs"
                    href={docsHref(entry)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    READ MORE IN DOCS ↗
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="script-editor__status">
        <span className="script-editor__position">
          LN {caretLine}, COL {caretColumn}
        </span>
        <span className="script-editor__context">
          {caretEntry
            ? caretEntry.signature
            : readOnly
              ? 'READ ONLY · HOVER A NAME FOR ITS REFERENCE'
              : 'CTRL+ENTER RUNS · CTRL+SPACE SUGGESTS · CTRL+/ COMMENTS'}
        </span>
      </p>
    </div>
  );
});
