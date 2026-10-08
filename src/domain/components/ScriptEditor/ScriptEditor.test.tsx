import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HIGHLIGHT_LIMIT, ScriptEditor } from './ScriptEditor';

/** The editor holding its own text, the way the dialog drives it. */
function Harness({ initial = '', onRun = () => {} }: { initial?: string; onRun?: () => void }) {
  const [value, setValue] = useState(initial);
  return <ScriptEditor label="Script" value={value} onChange={setValue} onRun={onRun} />;
}

const field = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Script' });

async function typeInto(text: string, initial = '') {
  render(<Harness initial={initial} />);
  const input = field();
  input.focus();
  input.setSelectionRange(initial.length, initial.length);
  await userEvent.keyboard(text);
  return input;
}

describe('ScriptEditor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('colours the code by what each part of it is', () => {
    const { container } = render(<Harness initial={"const box = scene.add('cube', 2); // note"} />);
    const kinds = (kind: string) =>
      [...container.querySelectorAll(`.script-editor__token--${kind}`)].map(
        (node) => node.textContent,
      );

    expect(kinds('keyword')).toEqual(['const']);
    expect(kinds('api')).toEqual(['scene', 'add']);
    expect(kinds('string')).toEqual(["'cube'"]);
    expect(kinds('number')).toEqual(['2']);
    expect(kinds('comment')).toEqual(['// note']);
  });

  it('draws a script too long to colour as plain lines, one span each', () => {
    const line = `[${'1, '.repeat(40)}1],`;
    const lines = Math.ceil(HIGHLIGHT_LIMIT / line.length) + 1;
    const { container } = render(<Harness initial={Array(lines).fill(line).join('\n')} />);

    expect(container.querySelectorAll('.script-editor__token--number')).toHaveLength(0);
    expect(container.querySelectorAll('.script-editor__token')).toHaveLength(lines);
    expect(field().value.split('\n')).toHaveLength(lines);
  });

  it('numbers every line, the last empty one included', () => {
    const { container } = render(<Harness initial={'a\nb\n'} />);
    expect(container.querySelectorAll('.script-editor__number')).toHaveLength(3);
  });

  it('closes a bracket as it is opened, and steps over the closer when it is typed', async () => {
    const input = await typeInto('add(');
    expect(input.value).toBe('add()');

    await userEvent.keyboard('1)');
    expect(input.value).toBe('add(1)');
    expect(input.selectionStart).toBe(6);
  });

  it('pairs a quote, but not straight after a word', async () => {
    const input = await typeInto("'");
    expect(input.value).toBe("''");

    input.setSelectionRange(2, 2);
    await userEvent.keyboard(" don't");
    expect(input.value).toBe("'' don't");
  });

  it('takes an empty pair back in one backspace', async () => {
    const input = await typeInto('[[{Backspace}');
    expect(input.value).toBe('');
  });

  it('carries the indent onto the next line', async () => {
    const input = await typeInto('{Enter}', '  a();');
    expect(input.value).toBe('  a();\n  ');
  });

  it('opens a deeper line between brackets, with the closer on a line of its own', async () => {
    render(<Harness initial="  if (a) {}" />);
    const input = field();
    input.focus();
    input.setSelectionRange(10, 10);

    await userEvent.keyboard('{Enter}');

    expect(input.value).toBe('  if (a) {\n    \n  }');
    expect(input.selectionStart).toBe(15);
  });

  it('indents and outdents the selected lines with Tab and Shift+Tab', async () => {
    render(<Harness initial={'a\nb'} />);
    const input = field();
    input.focus();
    input.setSelectionRange(0, 3);

    await userEvent.keyboard('{Tab}');
    expect(input.value).toBe('  a\n  b');

    input.setSelectionRange(0, input.value.length);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(input.value).toBe('a\nb');
  });

  it('comments the selected lines out and back in with Ctrl+/', async () => {
    render(<Harness initial={'  a();\n  b();'} />);
    const input = field();
    input.focus();
    input.setSelectionRange(0, input.value.length);

    await userEvent.keyboard('{Control>}/{/Control}');
    expect(input.value).toBe('  // a();\n  // b();');

    input.setSelectionRange(0, input.value.length);
    await userEvent.keyboard('{Control>}/{/Control}');
    expect(input.value).toBe('  a();\n  b();');
  });

  it('runs on Ctrl+Enter', async () => {
    const onRun = vi.fn();
    render(<Harness initial="scene.clear();" onRun={onRun} />);
    field().focus();

    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    expect(onRun).toHaveBeenCalledOnce();
    expect(field().value).toBe('scene.clear();');
  });

  it('suggests the members of a namespace after its dot, and inserts the one picked', async () => {
    const input = await typeInto('scene.ad');

    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('add'),
      expect.stringContaining('addMesh'),
    ]);

    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(input.value).toBe('scene.addMesh()');
    expect(input.selectionStart).toBe('scene.addMesh('.length);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the suggestions on Escape without touching the text', async () => {
    const input = await typeInto('scene.');
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input.value).toBe('scene.');
  });

  it('opens the suggestions on Ctrl+Space for a word not yet started', async () => {
    await typeInto('{Control>} {/Control}');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      expect.stringContaining('scene'),
      expect.stringContaining('view'),
    ]);
  });

  it('opens a balloon on an API name, with what it does and a link to its docs', () => {
    vi.useFakeTimers();
    const { container } = render(<Harness initial="scene.add('cube');" />);
    const add = [...container.querySelectorAll<HTMLElement>('[data-api]')].find(
      (node) => node.textContent === 'add',
    );
    if (!add) throw new Error('No API name was marked');

    // jsdom has no layout, so the point under the pointer is answered here.
    const elementsFromPoint = vi.fn(() => [field(), add]);
    Object.defineProperty(document, 'elementsFromPoint', {
      value: elementsFromPoint,
      configurable: true,
    });

    fireEvent.mouseMove(field(), { clientX: 40, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(400);
    });

    const balloon = screen.getByRole('tooltip');
    expect(balloon).toHaveTextContent('scene.add(kind, options?)');
    expect(balloon).toHaveTextContent(/Adds a primitive at the 3D cursor/);
    const link = screen.getByRole('link', { name: /READ MORE IN DOCS/ });
    expect(link).toHaveAttribute('href', '/docs#scripting/scene.add');
    expect(link).toHaveAttribute('target', '_blank');

    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it('marks the line that failed and puts the caret on it', () => {
    const { container, rerender } = render(
      <ScriptEditor label="Script" value={'a();\n  b();'} onChange={() => {}} onRun={() => {}} />,
    );

    rerender(
      <ScriptEditor
        label="Script"
        value={'a();\n  b();'}
        onChange={() => {}}
        onRun={() => {}}
        errorLine={2}
        errorKey={1}
      />,
    );

    expect(container.querySelector('.script-editor__line--error')).toHaveTextContent('b();');
    expect(field()).toHaveFocus();
    expect(field().selectionStart).toBe(7);
  });

  it('names the API call the caret is on in the status line', async () => {
    render(<Harness initial="view.frameAll();" />);
    const input = field();
    input.focus();
    input.setSelectionRange(7, 7);
    fireEvent.select(input);

    expect(screen.getByText('view.frameAll()')).toBeInTheDocument();
    expect(screen.getByText('LN 1, COL 8')).toBeInTheDocument();
  });
});
