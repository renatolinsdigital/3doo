import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Panel } from './Panel';

describe('Panel', () => {
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

  it('renders header actions when given', () => {
    render(
      <Panel title="MODIFIERS" actions={<button type="button">ADD</button>}>
        <p>body</p>
      </Panel>,
    );

    expect(screen.getByRole('button', { name: 'ADD' })).toBeInTheDocument();
  });
});
