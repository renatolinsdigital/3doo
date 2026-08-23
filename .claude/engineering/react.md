# React Conventions

Component-level conventions. Broader frontend architecture (styling system, routing, build setup) lives in `frontend.md`.

## Components

- Functional components with hooks only. No class components.
- One component per file. File name matches component name.
- Props typed with an explicit `interface`, never inline object types for anything non-trivial.

```tsx
interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
  onClick: () => void;
}

export function Button({ label, variant = 'primary', onClick }: ButtonProps) {
  return (
    <button className={styles[variant]} onClick={onClick}>
      {label}
    </button>
  );
}
```

## Hooks

- Business logic lives in custom hooks, not inline in components. A page component should read as a declarative summary of what it renders.
- Custom hooks are named `useX` and live under `/domain/hooks` or `/shared/hooks` depending on whether the logic is domain-specific or generic.

## State

- Local UI state: `useState`.
- Cross-cutting state shared by unrelated components: context, or a dedicated store if the app already has one. Don't reach for global state before local state is proven insufficient.

## Re-renders and memoization

- Default to no memoization. Reach for `useMemo` / `useCallback` / `React.memo` only when you've identified an actual problem (profiler shows a re-render that's visibly slow, or a dependency array is unstable and causing bugs), not as a blanket default.
- `useMemo` is for expensive computations (heavy loops, large-list filtering/sorting, non-trivial derived data), not for cheap expressions like `{ ...props }` or `a + b`. Wrapping cheap work in `useMemo` costs more (comparison, cache) than it saves.
- `useCallback` is only useful in two cases: the function is a dependency of another hook's dependency array (`useEffect`, `useMemo`), or it's passed as a prop to a child wrapped in `React.memo`. On its own, without one of those, `useCallback` does nothing for you.
- `React.memo` only pays off if the component re-renders often with the same props and the render itself is non-trivial. Wrapping a component in `React.memo` without also memoizing the callback/object props you pass it is a no-op, since new prop references defeat the comparison every time.
- Treat `useMemo`/`useCallback`/`React.memo` as a matched set: memoizing a child with `React.memo` obligates you to memoize the props (functions, objects, arrays) the parent passes it, or the memoization does nothing.
- Get dependency arrays right before reaching for memoization at all. A wrong array causes stale closures or bugs that no amount of memoization fixes.
- Never memoize to "future-proof" a component. Add it when a real perf problem is measured, and prefer fixing the actual cause (e.g. splitting a component, moving state down) over layering memoization on top.

```tsx
// Child is memoized, so the callback prop must be too. Otherwise React.memo is a no-op.
const Row = React.memo(function Row({ item, onSelect }: RowProps) {
  return <li onClick={() => onSelect(item.id)}>{item.label}</li>;
});

function List({ items }: ListProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const onSelect = useCallback((id: string) => setSelectedId(id), []);

  return (
    <ul>
      {items.map((item) => (
        <Row key={item.id} item={item} onSelect={onSelect} />
      ))}
    </ul>
  );
}
```

## Dumb vs domain components

- Shared components (`/shared/components`) are presentation-only: no API calls, no business logic, fully reusable.
- Domain components (`/domain/components`) can import domain state modules for business-specific problems.
