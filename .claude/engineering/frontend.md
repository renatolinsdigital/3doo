# Frontend

Enterprise-grade standards for the frontend application. This is the primary reference when scaffolding, extending, or reviewing frontend code. Component-level conventions live in `react.md`; language conventions live in `typescript.md`; testing philosophy in `testing.md`; performance in `performance.md`.

---

## Core Stack

- React (latest stable)
- Vite (latest stable)
- TypeScript (mandatory, strict mode)
- Sass (SCSS only, no Tailwind)
- CSS Modules per component
- React Router for routing
- Vitest + React Testing Library for tests
- ESLint + Prettier
- Husky + lint-staged for commit hooks

Do not introduce Tailwind or other utility-CSS frameworks into this codebase.

---

## Styling Architecture

### Key considerations

- No global CSS outside the `global-styles` system.
- No inline styles unless truly unavoidable (and never for anything reusable).
- No style duplication between components; extract shared patterns into `global-styles/helpers.scss` or a mixin.

### Component styling rules

Each UI component should be placed in its own folder. Individual component folders should **not** contain an `index.ts` file. Instead, the parent `components` folder should provide a single `index.ts` that exports all components.

For React projects, each component folder should contain:

* The component implementation file (e.g., `.tsx`)
* The corresponding test file (e.g., `.test.tsx` or `.spec.tsx`)
* A `.scss` file for Sass styles

### Global styling structure

```
/src/global-styles/
  reset.scss
  theme.scss
  helpers.scss
  responsive-mixins.scss
  animations.scss
  index.scss
```

- **reset.scss**: modern CSS reset.
- **theme.scss**: color palette (primary, secondary, success, warning, error, info, neutral scale), typography scale, spacing scale, border radius tokens, z-index scale.
- **helpers.scss**: utility classes, only when truly global.
- **responsive-mixins.scss**: media query mixins for mobile, tablet, desktop.
- **animations.scss**: reusable animation definitions.
- **index.scss**: imports and wires everything together.

The application is theme-driven: colors, spacing, and typography always come from `theme.scss` tokens, never hardcoded values in component styles.

---

## Project Architecture

```
/src
  /app
  /pages
  /domain
    /components
    /hooks
    /services
    /helpers
  /shared
    /components
    /icons
    /hooks
    /helpers
  /routes
  /global-styles
  /tests
/docs
```

### Shared components

Reusable, presentation-only, no business logic: Button, Input, Label, Modal, Toast, Loader, Card, Typography, layout wrappers. Located in `/shared/components`.

### Domain components

Contain domain-related logic, compose shared components. Located in `/domain/components`.

### Hooks

Business logic is isolated in custom hooks (see `react.md`). Pages stay declarative and thin.

---

## Routing

- `/` → Home. Explains the project clearly.
- `/converter` (or equivalent primary feature route) → the main functional page.
- `/about` → contact page with a form.

Each page is a component inside `/pages`, mapped through a central router file, with smooth transitions between routes. Routes are lazy-loaded (see `performance.md`).

---

## Absolute Imports

Configure both Vite and `tsconfig.json` to support:

```
@/shared/...
@/domain/...
@/pages/...
@/global-styles/...
```

Relative imports beyond one level (`../../../../`) are not allowed.

---

## Design System

- Consistent spacing scale, typography scale, and border radius, all sourced from `theme.scss`.
- Accessible color contrast (see the Accessibility section below).
- Reusable UI primitives instead of one-off styled elements.
- Motion consistency across the app (see Animations).

---

## Animations & UX

- Subtle, professional animations only. Avoid anything flashy or distracting.
- Page transitions feel modern and consistent.
- Use CSS animations or a lightweight animation library. No heavy dependencies for motion.

---

## Toast System

Shared component with four variants: success, error, warning, info.

**Behavior:**

- Auto-dismiss after 3 seconds.
- Animated progress bar that shrinks with time.
- Smooth enter and exit transitions.
- Never requires clicking an "X" to dismiss.
- Stacked positioning when multiple toasts are active.
- Accessible, with proper ARIA roles.

**Inline feedback vs toast:** use inline feedback for errors tied to a specific field or action the user needs to correct in place (e.g. form validation). Use a toast for feedback about an action's overall outcome that doesn't require the user to stay focused on a specific element (e.g. "changes saved," "request failed, try again").

---

## Accessibility (A11y)

Follow WCAG best practices:

- Semantic HTML first, ARIA roles only to fill genuine gaps.
- Full keyboard navigation support.
- Visible focus management, especially after route changes and modal open/close.
- Every form input properly labeled.
- Error states clearly described in text, not conveyed by color alone.
- Sufficient contrast ratios per the tokens in `theme.scss`.

---

## Performance

- Lazy-loaded routes and code splitting (see `performance.md`).
- Memoization used deliberately, not by default (see `react.md`).
- No unused dependencies left in `package.json`.
- Optimized production bundle output; check `npm run build` output size when adding a new dependency.

---

## Testing

Every component ships with:

- A rendering test.
- A behavior test where applicable.

Use Vitest + React Testing Library. Colocate tests with components or place under `/tests`, matching whatever the repo has already standardized on. Coverage reporting is configured; see `testing.md` for what coverage should and shouldn't be used for.

---

## Responsiveness

The application must work correctly on mobile, tablet, and desktop, using the mixins in `responsive-mixins.scss`. Test all defined breakpoints and make sure layout shifts are intentional, not accidental.

---

## Forms

The contact/about form (and any form generally) requires:

- Name, email, message (or the fields relevant to the specific form).
- Client-side validation with accessible error messaging.
- A visible loading state during submission.
- Success and error feedback via toast or inline messaging, chosen per the rule in the Toast System section above.

---

## Code Quality Tooling

- ESLint with strict rules, Prettier for formatting.
- Husky + lint-staged: pre-commit hook runs lint and tests, blocks the commit on failure.

---

## Documentation

Frontend-specific documentation (component catalog, design decisions, accessibility notes) is maintained under `/docs` in the project, separate from this `.claude/` knowledge base. Keep the two in sync when a documented convention changes.
