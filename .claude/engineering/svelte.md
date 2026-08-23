# Svelte Conventions

Component-level conventions. Broader frontend architecture (styling system, routing, build setup) lives in `frontend.md`.

## Components

- Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`). No Svelte 4 `export let`/reactive-statement (`$:`) style in new code.
- One component per folder: `ComponentName.svelte`, a colocated `_ComponentName.scss` partial, `ComponentName.spec.ts`. File name and component name are both `PascalCase`.
- Props typed with an explicit interface destructured from `$props()`, never untyped props for anything non-trivial.

```svelte
<script lang="ts">
  interface Props {
    label: string;
    variant?: 'primary' | 'secondary';
    onClick: () => void;
  }

  let { label, variant = 'primary', onClick }: Props = $props();
</script>

<button class={variant} onclick={onClick}>{label}</button>

<style lang="scss">
  @use './ComponentName' as *;
</style>
```

## Business logic

- Business logic lives in `.svelte.ts` rune modules or plain functions, not inline in the component. A page component should read as a declarative summary of what it renders.
- Shared reactive modules are named `useX.svelte.ts` or `xStore.svelte.ts` and live under `/domain/state` or `/shared/state` depending on whether the logic is domain-specific or generic.

## State

- Local UI state: `$state`.
- Derived state: `$derived`, never an `$effect` that manually assigns another `$state` value — that's a sign the value should be derived instead.
- Cross-cutting state shared by unrelated components: a `.svelte.ts` module exporting runed state (or Svelte stores if the app already uses them). Don't reach for a shared module before local state + prop drilling is proven insufficient.

## Reactivity and performance

- Default to no manual optimization. `$derived` already recomputes only when its dependencies change; don't hand-roll caching around it.
- `$effect` is for side effects (fetching, syncing external state, DOM measurement), not for deriving a value another part of the template needs — that's what `$derived` is for.
- Keep `$derived` expressions pure; an `$effect` that writes back into a `$state` value it also reads is a common source of infinite-loop bugs.
- Svelte's compiler already does fine-grained, per-node DOM updates — there is no `React.memo` equivalent to reach for. Get the rune dependencies right rather than looking for a memoization primitive.

## Naming

- Components: `PascalCase` file name, used as `PascalCase` tags in templates (`<UserCard />`).
- Rune modules: `camelCase`, prefixed `use` for composable-style state (`useAuth.svelte.ts`), or suffixed `Store` for a shared singleton (`authStore.svelte.ts`).
- Props/callbacks: `camelCase`, event-handler props named `onX` (`onClick`, `onSelect`), matching native DOM event naming.

## Dumb vs domain components

- Shared components (`/shared/components`) are presentation-only: no data fetching, no imported domain state modules, driven entirely by props/callbacks, fully reusable.
- Domain components (`/domain/components`) can import domain state modules for business-specific problems.
