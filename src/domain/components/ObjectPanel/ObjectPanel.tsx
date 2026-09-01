import { Button, FieldRow, Panel } from '@shared/components';
import { useEditorStore } from '@store/index';

/** Object-mode operators: what they act on is the selection, not a parameter. */
export function ObjectPanel() {
  const duplicateSelected = useEditorStore((state) => state.duplicateSelected);
  const mergeSelected = useEditorStore((state) => state.mergeSelected);
  const separateLooseParts = useEditorStore((state) => state.separateLooseParts);
  const applyTransform = useEditorStore((state) => state.applyTransformToSelected);
  const exec = useEditorStore((state) => state.exec);

  return (
    <Panel title="OBJECT">
      <FieldRow columns={1}>
        <Button
          label="DUPLICATE"
          hint="Copy the selected object(s) with an independent mesh (Shift+D)"
          onClick={() => duplicateSelected(false)}
        />
        <Button
          label="LINKED DUPLICATE"
          hint="Copy the selected object(s) sharing the same mesh data (Alt+D)"
          onClick={() => duplicateSelected(true)}
        />
        <Button
          label="MERGE SELECTED"
          hint="Merge the selected objects into the active one, each keeping where it sits, with the origin on the middle of the result (M)"
          onClick={mergeSelected}
        />
        <Button
          label="SEPARATE"
          hint="Split the active object into separate objects, one for each loose part, each with its origin on its own middle (P)"
          onClick={separateLooseParts}
        />
        <Button
          label="APPLY TRANSFORM"
          hint="Bake rotation and scale into the mesh so modifiers and exports see the real shape (Ctrl+A)"
          onClick={() => applyTransform()}
        />
        <Button
          label="RECALCULATE NORMALS"
          hint="Make winding consistent and point normals outward (Shift+N)"
          onClick={() => exec('recalculateNormals', { outside: true }, 'Recalculate normals')}
        />
      </FieldRow>
    </Panel>
  );
}
