import { TextField } from '../TextField/TextField';

export interface RenameFieldProps {
  /** The name being edited: the field opens on it, and falls back to it when emptied. */
  name: string;
  onRename: (name: string) => void;
  onCancel: () => void;
}

/**
 * A name edited in place: Enter or leaving the field keeps the new one, Escape
 * abandons it, and a name cleared down to nothing keeps the old one.
 */
export function RenameField({ name, onRename, onCancel }: RenameFieldProps) {
  return (
    <TextField
      label={`Rename ${name}`}
      defaultValue={name}
      autoFocus
      onBlur={(event) => onRename(event.target.value.trim() || name)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') onCancel();
      }}
    />
  );
}
