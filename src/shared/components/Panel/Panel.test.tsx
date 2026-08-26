import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { Panel } from './Panel';

describe('Panel', () => {
  beforeEach(() => {
    useEditorStore.getState().setCollapsedPanels({});
  });

  it('renders its title and children', () => {
    render(
      <Panel title="OUTLINER">
        <p>Cube</p>
      </Panel>,
    );

    expect(screen.getByRole('heading', { name: 'OUTLINER' })).toBeInTheDocument();
    expect(screen.getByText('Cube')).toBeInTheDocument();
  });

  it('labels the region for screen readers', () => {
    render(
      <Panel title="PROPERTIES">
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByRole('region', { name: 'PROPERTIES' })).toBeInTheDocument();
  });

  it('folds its body away when the title is clicked', async () => {
    render(
      <Panel title="OUTLINER">
        <p>Cube</p>
      </Panel>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'OUTLINER' }));

    expect(screen.queryByText('Cube')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'OUTLINER' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('renders header actions when given', () => {
    render(
      <Panel title="MODIFIERS" actions={<button type="button">ADD</button>}>
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByRole('button', { name: 'ADD' })).toBeInTheDocument();
  });
});
