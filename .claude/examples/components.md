# Example: Shared Component

Reference pattern for a shared, presentation-only component. Mirror this structure for new components under `/shared/components`. See `engineering/react.md` and `engineering/frontend.md` for the full rules this example follows.

```
/shared/components/Button/
  Button.tsx
  Button.module.scss
  Button.test.tsx
  index.ts
```

**Button.tsx**

```tsx
import styles from './Button.module.scss';

interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  onClick: () => void;
}

export function Button({ label, variant = 'primary', disabled, onClick }: ButtonProps) {
  return (
    <button
      className={styles[variant]}
      disabled={disabled}
      onClick={onClick}
      aria-disabled={disabled}
    >
      {label}
    </button>
  );
}
```

**Button.module.scss**

```scss
@use '@/global-styles/theme' as theme;

.primary {
  background: theme.$color-primary;
  color: theme.$color-on-primary;
  border-radius: theme.$radius-md;
  padding: theme.$space-sm theme.$space-md;
}

.secondary {
  background: transparent;
  border: 1px solid theme.$color-primary;
  color: theme.$color-primary;
}
```

**Button.test.tsx**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';

test('renders the label', () => {
  render(<Button label="Save" onClick={() => {}} />);
  expect(screen.getByText('Save')).toBeInTheDocument();
});

test('calls onClick when clicked', () => {
  const onClick = jest.fn();
  render(<Button label="Save" onClick={onClick} />);
  fireEvent.click(screen.getByText('Save'));
  expect(onClick).toHaveBeenCalledTimes(1);
});
```

**index.ts**

```ts
export { Button } from './Button';
```
