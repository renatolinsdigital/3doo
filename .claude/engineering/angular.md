# Angular Conventions

Component-level conventions. Broader frontend architecture (styling system, routing, build setup) lives in `frontend.md`.

## Components

- Standalone components only. No `NgModule`-based components in new code.
- One component per folder: `component-name.component.ts`, `.html`, `.scss`, `.spec.ts`. Folder name matches the selector minus the app prefix.
- `ChangeDetectionStrategy.OnPush` on every component, no exceptions without a documented reason.
- Selector always prefixed (`app-button`, not bare `button`).

```ts
@Component({
  selector: 'app-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './button.component.html',
  styleUrl: './button.component.scss',
})
export class ButtonComponent {
  label = input.required<string>();
  variant = input<'primary' | 'secondary'>('primary');
  clicked = output<void>();
}
```

## Inputs and outputs

- Prefer signal-based `input()` / `input.required()` / `output()` over decorator-based `@Input`/`@Output` in new code (Angular 17+) — same intent, better type inference, no `!` assertions needed.
- Every input is explicitly typed. No `any`, no untyped object inputs for anything non-trivial.
- A component should be fully controllable through its inputs/outputs. Avoid reaching into a child via `@ViewChild` to set state an input could carry instead.

## Business logic

- Business logic lives in injectable services, not inline in components. A component class should read as a thin adapter between the template and a service.
- Services are `providedIn: 'root'` unless intentionally scoped to a feature route or component subtree.
- Prefer the `async` pipe or `toSignal()` over manual `.subscribe()` in components — both handle unsubscription and change detection for you.

## State

- Local UI state: signals (`signal()`, `computed()`).
- Cross-cutting state shared by unrelated components: a dedicated service exposing signals (or `BehaviorSubject`), or NgRx if the app already has a store. Don't reach for a store before a shared service is proven insufficient.

## Change detection and reactivity

- `OnPush` plus signals is the default rendering model; components should rarely need `markForCheck()`.
- Don't call methods from templates for anything non-trivial (`{{ getTotal() }}`) — it re-runs on every check. Use `computed()` or a pipe instead.
- Any manual RxJS subscription must be torn down (`takeUntilDestroyed()`), or replaced entirely with `async pipe` / `toSignal()`.

## Naming

- Selectors: kebab-case, always prefixed (`app-user-card`).
- Classes: `PascalCase`, suffixed by role (`UserCardComponent`, `UserService`, `AuthGuard`).
- Files: kebab-case matching the class (`user-card.component.ts`).

## Dumb vs domain components

- Shared components (`/shared/components`) are presentation-only: driven entirely by inputs/outputs, no injected services beyond pure utilities (formatting, i18n), fully reusable across features.
- Domain components (`/domain/<feature>/components`) inject services, compose shared components, and own the business logic for their feature.
