# Markdown Conventions

## Headings

- One `#` H1 per file, matching the file's purpose.
- Use `##` and `###` for sections and subsections. Don't skip levels.

## Code blocks

- Always tag the language: `ts, `bash, `json, not bare ` ```.
- Keep example code runnable and minimal. Strip unrelated boilerplate.

## Lists

- Use `-` for unordered lists, not `*`, for consistency across files.
- Use numbered lists only when order actually matters (steps, ranked priorities).

## Tables

- Use tables for comparisons or structured reference data (options, flags, environment variables), not as a substitute for prose explanation.

## Links

- Use descriptive link text ("see the migration guide"), never bare "click here."
- Prefer relative links between files inside this repo over hardcoded absolute URLs.

## File naming

- Lowercase, hyphen-separated: `api-reference.md`, not `API_Reference.md`.
