import type { CSSProperties, InputHTMLAttributes } from 'react';

import './TextField.scss';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Accessible name. The field draws no visible label of its own. */
  label: string;
  /** Overrides the padding-driven height; a number is read as pixels. */
  height?: CSSProperties['height'];
}

/**
 * A single-line text field.
 *
 * Knows nothing beyond what it is handed: `value` or `defaultValue`, and every
 * other input attribute, pass straight through, so a controlled project name
 * and an uncontrolled rename-in-place are the same component.
 *
 * Focus recolours the field's own border rather than ringing it, which is what
 * keeps a focused field to one frame instead of two. Callers vary the surface
 * through `--text-field-surface` and the height through `height`.
 */
export function TextField({
  label,
  height,
  className,
  style,
  type = 'text',
  ...rest
}: TextFieldProps) {
  return (
    <input
      type={type}
      className={['text-field', className ?? ''].filter(Boolean).join(' ')}
      aria-label={label}
      style={height === undefined ? style : { height, ...style }}
      {...rest}
    />
  );
}
