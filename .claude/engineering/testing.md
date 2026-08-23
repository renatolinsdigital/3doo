# Testing

Shared testing philosophy. Stack-specific tooling (Vitest configs, RTL patterns, NestJS testing module) lives in `frontend.md` and `backend.md`.

## What must be tested

- Every component or service ships with at least a rendering/instantiation test and a behavior test where applicable.
- Business logic (hooks, services, use cases) gets unit tests independent of the framework wiring around it.
- Bug fixes get a regression test that fails before the fix and passes after.

## What not to over-test

- Don't test framework internals (that React renders a `<div>` you told it to render).
- Don't test implementation details that would break on a harmless refactor. Test behavior and output, not internals.

## Structure

- Colocate tests with the code they cover (`Button.tsx` + `Button.test.tsx`), or place them under `/tests` if the project has standardized on that. Pick one convention per repo and stay consistent.
- Arrange / Act / Assert structure inside each test.

## Coverage

- Coverage reporting is enabled, but coverage percentage is a signal, not a target to game. A meaningful test on critical logic beats ten trivial tests padding a number.
