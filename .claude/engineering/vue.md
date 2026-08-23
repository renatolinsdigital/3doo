# Vue Conventions

Component-level conventions. Broader frontend architecture (styling system, routing, build setup) lives in `frontend.md`.

## Components

- Composition API with `<script setup lang="ts">` only. No Options API in new code.
- One component per folder: `ComponentName.vue`, `ComponentName.scss`, `ComponentName.spec.ts`. File name and component name are both `PascalCase`.
- Props typed with an explicit interface passed to `defineProps<Props>()`, never inline object types for anything non-trivial.

```vue
<script setup lang="ts">
interface ButtonProps {
  label: string;
  variant?: 'primary' | 'secondary';
}

withDefaults(defineProps<ButtonProps>(), { variant: 'primary' });
defineEmits<{ click: [] }>();
</script>

<template>
  <button :class="$style[variant]" @click="$emit('click')">{{ label }}</button>
</template>

<style lang="scss" module src="./Button.scss" />
```

## Composables

- Business logic lives in composables (`useX`), not inline in `<script setup>`. A page component should read as a declarative summary of what it renders.
- Composables are named `useX` and live under `/domain/composables` or `/shared/composables` depending on whether the logic is domain-specific or generic.

## State

- Local UI state: `ref` / `reactive`.
- Derived state: `computed`, never a `watch` that manually assigns another ref — that's a sign the value should be computed instead.
- Cross-cutting state shared by unrelated components: `provide`/`inject`, or Pinia if the app already has a store. Don't reach for Pinia before local state + `provide`/`inject` is proven insufficient.

## Reactivity and performance

- Default to no manual optimization. `computed` already caches its result; don't wrap cheap expressions in it "for perf."
- `watch`/`watchEffect` are for side effects (fetching, syncing external state, logging), not for deriving a value another part of the template needs — that's what `computed` is for.
- `v-memo` and `shallowRef`/`shallowReactive` are for measured problems (profiler shows a slow re-render on a large list), not a default. Get the reactive dependency right before reaching for either.
- Never add `v-memo` or a shallow ref to "future-proof" a component; add it when a real perf problem is measured, and prefer fixing the actual cause (splitting the component, moving state down) first.

## Naming

- Components: `PascalCase` file and tag usage (`<UserCard />`), kebab-case is only for native/third-party elements.
- Composables: `camelCase`, always prefixed `use` (`useAuth`, `useDebounce`).
- Props/emits: `camelCase` in script, kebab-case when bound as a native DOM attribute.

## Dumb vs domain components

- Shared components (`/shared/components`) are presentation-only: no API calls, no injected stores, driven entirely by props/emits, fully reusable.
- Domain components (`/domain/components`) can import domain state modules for business-specific problems.
