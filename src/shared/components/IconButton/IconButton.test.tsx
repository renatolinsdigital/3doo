import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { IconButton } from './IconButton';

describe('IconButton', () => {
  beforeEach(() => {
    useEditorStore.setState({ hint: null, tooltipsEnabled: true });
  });

  it('names the button from its label, not the glyph', () => {
    render(<IconButton label="Extrude" icon="E" onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'Extrude' })).toBeInTheDocument();
  });

  it('shows the shortcut in the hint tooltip on focus', () => {
    render(<IconButton label="Extrude" icon="E" shortcut="E" onClick={() => {}} />);

    fireEvent.focus(screen.getByRole('button', { name: 'Extrude' }));

    expect(useEditorStore.getState().hint?.text).toBe('Extrude (E)');
  });

  it('prefers an explicit hint over the default label/shortcut text', () => {
    render(
      <IconButton
        label="Extrude"
        icon="E"
        shortcut="E"
        hint="Pulls the selected faces along their normal"
        onClick={() => {}}
      />,
    );

    fireEvent.focus(screen.getByRole('button', { name: 'Extrude' }));

    expect(useEditorStore.getState().hint?.text).toBe(
      'Pulls the selected faces along their normal',
    );
  });

  it('fires on click', async () => {
    const onClick = vi.fn();
    render(<IconButton label="Bevel" icon="B" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button', { name: 'Bevel' }));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
