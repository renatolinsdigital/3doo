import { useEffect, useState } from 'react';

import { countMergeByDistance } from '@kernel/index';
import { Button, Modal, NumberField } from '@shared/components';
import { useActiveObject, useEditorStore } from '@store/index';

import './MergeDialog.scss';

/**
 * Merge by distance with a live preview.
 *
 * The count comes from a dry run of the same planner the operator uses, so what
 * the dialog promises is exactly what committing will do.
 */
export function MergeDialog() {
  const open = useEditorStore((state) => state.dialog === 'merge');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const exec = useEditorStore((state) => state.exec);
  const object = useActiveObject();

  const [threshold, setThreshold] = useState(0.001);
  const [removed, setRemoved] = useState(0);

  useEffect(() => {
    if (!open || !object) return;

    const selected = object.mesh.selectedVerts();
    const target = selected.length > 0 ? selected : [...object.mesh.verts.values()];
    setRemoved(countMergeByDistance(target, threshold));
  }, [open, object, threshold]);

  if (!object) return null;

  const scope = object.mesh.selectedVerts().length > 0 ? 'selected vertices' : 'the whole mesh';

  return (
    <Modal
      title="MERGE BY DISTANCE"
      open={open}
      onClose={closeDialog}
      footer={
        <>
          <Button label="CANCEL" onClick={closeDialog} />
          <Button
            label="MERGE"
            variant="primary"
            disabled={removed === 0}
            onClick={() => {
              exec('mergeByDistance', { threshold }, 'Merge by distance');
              closeDialog();
            }}
          />
        </>
      }
    >
      <NumberField
        label="DISTANCE"
        value={threshold}
        step={0.001}
        min={0}
        precision={5}
        onChange={setThreshold}
      />

      <p className="merge-dialog__preview">
        <strong>{removed}</strong> {removed === 1 ? 'vertex' : 'vertices'} will be removed from{' '}
        {scope}.
      </p>
      <p className="merge-dialog__hint">
        This is the primary automatic topology cleanup. Raise the distance until doubled vertices
        disappear, but stop before the count starts eating real geometry.
      </p>
    </Modal>
  );
}
