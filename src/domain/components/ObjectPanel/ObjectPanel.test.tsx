import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useEditorStore } from '@store/index';

import { ObjectPanel } from './ObjectPanel';

describe('ObjectPanel', () => {
  beforeEach(() => {
    const store = useEditorStore.getState();
    store.resetScene();
    store.addPrimitive('cube');
  });

  it('cuts the active object in half across the axis picked', async () => {
    render(<ObjectPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'CUT IN HALF ON Y' }));

    const { objects } = useEditorStore.getState();
    expect(objects.map((object) => object.name)).toEqual(['CUBE.-Y', 'CUBE.+Y']);
  });
});
