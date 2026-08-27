import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { Accordion } from './Accordion';

describe('Accordion', () => {
  it('starts folded, showing its title alone', () => {
    render(
      <Accordion title="GRID">
        <p>SCALE</p>
      </Accordion>,
    );

    expect(screen.getByRole('button', { name: 'GRID' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('SCALE')).not.toBeInTheDocument();
  });

  it('opens and folds again from the title', async () => {
    render(
      <Accordion title="GRID">
        <p>SCALE</p>
      </Accordion>,
    );
    const toggle = screen.getByRole('button', { name: 'GRID' });

    await userEvent.click(toggle);
    expect(screen.getByText('SCALE')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(toggle);
    expect(screen.queryByText('SCALE')).not.toBeInTheDocument();
  });

  it('can start open, for the section a dialog leads with', () => {
    render(
      <Accordion title="INTERFACE" defaultOpen>
        <p>SHOW HINT TOOLTIPS</p>
      </Accordion>,
    );

    expect(screen.getByText('SHOW HINT TOOLTIPS')).toBeInTheDocument();
  });

  it('points the body back at the control that folds it', () => {
    render(
      <Accordion title="VIEWPORT" defaultOpen>
        <p>BACKGROUND</p>
      </Accordion>,
    );

    const controls = screen.getByRole('button', { name: 'VIEWPORT' }).getAttribute('aria-controls');
    expect(document.getElementById(controls ?? '')).toHaveTextContent('BACKGROUND');
  });
});
