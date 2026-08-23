# Writing Style Guide

Conventions for any text in this repository: README updates, doc comments, code comments, UI copy, data files (e.g. `books.json`), PR descriptions, `/docs` content. Applies everywhere text appears, not just prose Claude generates fresh. When editing a file for another reason, bring any text you touch into line with this guide too.

## Language and Style

- All writing should be in English, using US spelling ("color," "behavior," "license," not "colour," "behaviour," "licence").
- Never use em dashes anywhere, including code comments and section-divider comments (e.g. `// -- Section --`). Use a comma, parentheses, a colon, or split into two sentences instead. This is one of the clearest tells of robotic or AI-generated writing.
- Use terminology consistently with `product/glossary.md` and `product/terminology.md`. Don't invent a synonym for a term those files already define.
- Spell out acronyms and abbreviations on first use per document (e.g., "Application Programming Interface (API)"), then use the short form for the rest of the document.
- Contractions are fine ("don't," "it's," "you'll") and generally preferred over the stiffer formal alternative. Don't contort a sentence just to avoid one.

## Tone

- Direct and plain. Prefer short sentences over long compound ones.
- Explain the "why" behind a decision, not just the "what."
- Avoid marketing language ("seamless," "powerful," "cutting-edge"). Describe what something does, not how impressive it is.

## Structure

- Lead with the most important information. Don't bury the point in a preamble.
- Use headings to let a reader scan and jump to what they need, not to pad length.
- Prefer short paragraphs and lists over dense blocks of text when describing steps or options.

## Voice

- Write in second person when addressing the developer directly ("you'll need to...").
- Write in third person / neutral for architectural decisions ("the API layer handles...").
- Avoid exclamation points and hype in technical writing.

## Things to avoid

- Filler transitions ("In today's fast-paced world...").
- Restating the obvious ("This function is a function that...").
- Redundant qualifiers ("very unique," "extremely critical").
