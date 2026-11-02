import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { MergeDialog } from './MergeDialog';

const store = () => useEditorStore.getState();

describe('MergeDialog', () => {
  beforeEach(() => {
    store().resetScene();
    store().addPrimitive('cube');
    store().setMode('edit');
    store().openDialog('merge');
  });

  it('opens on a distance of 0.0005', () => {
    render(<MergeDialog />);

    expect(screen.getByLabelText('DISTANCE')).toHaveValue('0.0005');
  });

  it('steps the distance in tenths of a millimetre', async () => {
    render(<MergeDialog />);
    const field = screen.getByLabelText('DISTANCE');

    await userEvent.click(field);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    await userEvent.tab();

    // The arrows used to move in steps of 0.001, so one press down from the
    // old default landed on zero and nothing between could be reached without
    // typing it.
    expect(field).toHaveValue('0.0001');
  });
});
