import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { ContextMenu } from './ContextMenu';

/** Mirrors how the viewport mounts the menu: closing it unmounts the entries. */
function Harness() {
  const [open, setOpen] = useState(true);
  if (!open) return null;

  return (
    <ContextMenu
      x={0}
      y={0}
      label="CURSOR MENU"
      entries={[
        {
          id: 'point',
          label: 'PLACE HERE',
          hint: 'Put the cursor exactly where you clicked',
          onSelect: () => {},
        },
      ]}
      onClose={() => setOpen(false)}
    />
  );
}

describe('ContextMenu', () => {
  beforeEach(() => {
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

  it('shows its label as a title and names the menu with it', () => {
    render(<Harness />);

    expect(screen.getByRole('menu', { name: 'CURSOR MENU' })).toBeInTheDocument();
    expect(screen.getByText('CURSOR MENU')).toBeInTheDocument();
  });

  it('clears a visible hint when picking an entry closes the menu', async () => {
    render(<Harness />);
    const entry = screen.getByRole('menuitem', { name: 'PLACE HERE' });

    fireEvent.focus(entry);
    expect(useEditorStore.getState().hint?.text).toBe('Put the cursor exactly where you clicked');

    await userEvent.click(entry);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(useEditorStore.getState().hint).toBeNull();
  });
});
