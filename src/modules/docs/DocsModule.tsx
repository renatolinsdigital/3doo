import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { navigate } from '@app/router';
import { SiteFooter } from '@domain/components';
import { Button, TextField } from '@shared/components';

import { type DocsBlock, type DocsResult, DOCS_SECTIONS, searchDocs, searchTerms } from './content';

import './DocsModule.scss';

/**
 * What the URL fragment points at: a section, and optionally one row of it,
 * as `#scripting/scene.add`. An unknown section falls back to the first.
 */
function placeFromHash(): { section: string; row: string | null } {
  const [id, ...rest] = window.location.hash.replace('#', '').split('/');
  const known = DOCS_SECTIONS.some((section) => section.id === id);
  return {
    section: known ? id : DOCS_SECTIONS[0].id,
    row: known && rest.length > 0 ? rest.join('/') : null,
  };
}

/** The element id a row anchored as `id` carries. */
const rowAnchor = (id: string) => `docs-${id}`;

export function DocsModule() {
  const [activeId, setActiveId] = useState(() => placeFromHash().section);
  const [targetRow, setTargetRow] = useState(() => placeFromHash().row);
  const [query, setQuery] = useState('');
  const search = useRef<HTMLDivElement>(null);

  const active = DOCS_SECTIONS.find((section) => section.id === activeId) ?? DOCS_SECTIONS[0];
  const terms = useMemo(() => searchTerms(query), [query]);
  const results = useMemo(() => searchDocs(query), [query]);
  const searching = terms.length > 0;

  // The fragment is what makes a section linkable. Replaced rather than pushed,
  // so reading through the docs does not bury the previous module under a dozen
  // back-button steps.
  useEffect(() => {
    const row = targetRow ? `/${targetRow}` : '';
    window.history.replaceState(null, '', `/docs#${activeId}${row}`);
  }, [activeId, targetRow]);

  useEffect(() => {
    const onHashChange = () => {
      const place = placeFromHash();
      setActiveId(place.section);
      setTargetRow(place.row);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A link to one row lands on it, rather than at the top of a long section.
  useEffect(() => {
    if (!targetRow) return;
    document.getElementById(rowAnchor(targetRow))?.scrollIntoView?.({ block: 'center' });
  }, [activeId, targetRow]);

  // The one shortcut this module has, and the same key the docs sites people
  // arrive from use for it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      search.current?.querySelector('input')?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Opening a section is what the menu means, searching or not, so the query
  // goes with the click rather than leaving the menu pointing at a list the
  // content no longer shows.
  const open = (id: string) => {
    setQuery('');
    setTargetRow(null);
    setActiveId(id);
  };

  const listed = searching ? results.map((result) => result.section) : DOCS_SECTIONS;
  const hits = new Map(results.map((result) => [result.section.id, result.count]));

  return (
    <div className="docs">
      <header className="docs__bar">
        <ModuleSwitcher />
        <Button label="OPEN MODELING" variant="primary" onClick={() => navigate('/modeling')} />
      </header>

      <div className="docs__body">
        <nav className="docs__nav" aria-label="Documentation">
          <div className="docs__nav-head">
            <p className="docs__nav-title">CONTENTS</p>
            <div className="docs__search" ref={search}>
              <TextField
                label="Search the documentation"
                className="docs__search-field"
                height="var(--control-sm)"
                placeholder="SEARCH  /"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
              />
              {query !== '' && (
                <button
                  type="button"
                  className="docs__search-clear"
                  aria-label="Clear the search"
                  onClick={() => setQuery('')}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {listed.map((section) => (
            <button
              key={section.id}
              type="button"
              className="docs__nav-item"
              aria-current={!searching && section.id === active.id ? 'page' : undefined}
              onClick={() => open(section.id)}
            >
              <span className="docs__nav-label">
                {section.title}
                {searching && <span className="docs__nav-count">{hits.get(section.id)}</span>}
              </span>
              <span className="docs__nav-blurb">{section.blurb}</span>
            </button>
          ))}

          {searching && listed.length === 0 && <p className="docs__nav-none">NO MATCHES</p>}
        </nav>

        <main className="docs__content" key={searching ? `search:${query}` : active.id}>
          <div className="docs__article">
            {searching ? (
              <SearchResults query={query} results={results} terms={terms} onOpen={open} />
            ) : (
              <>
                <h1 className="docs__title">{active.title}</h1>
                <p className="docs__blurb">{active.blurb}</p>
                {active.blocks.map((block, index) => (
                  <DocsBlockView key={index} block={block} targetRow={targetRow} />
                ))}
              </>
            )}
          </div>
        </main>
      </div>

      <SiteFooter className="docs__footer" />
    </div>
  );
}

function SearchResults({
  query,
  results,
  terms,
  onOpen,
}: {
  query: string;
  results: readonly DocsResult[];
  terms: readonly string[];
  onOpen: (id: string) => void;
}) {
  if (results.length === 0) {
    return (
      <>
        <h1 className="docs__title">NO MATCHES</h1>
        <p className="docs__blurb">Nothing in the documentation mentions {query}</p>
        <p className="docs__prose">
          Every word you type has to appear, so a long phrase narrows fast. Try one word on its own:
          the name of an operation, a panel or a key.
        </p>
      </>
    );
  }

  const total = results.reduce((sum, result) => sum + result.count, 0);

  return (
    <>
      <h1 className="docs__title">SEARCH</h1>
      <p className="docs__blurb">
        {total} {total === 1 ? 'match' : 'matches'} in {results.length}{' '}
        {results.length === 1 ? 'section' : 'sections'}
      </p>

      {results.map((result) => (
        <section key={result.section.id} className="docs__result">
          <button
            type="button"
            className="docs__result-head"
            onClick={() => onOpen(result.section.id)}
          >
            <span>{result.section.title}</span>
            <span className="docs__result-count">OPEN</span>
          </button>

          <div className="docs__result-body">
            {result.blocks.length === 0 ? (
              <p className="docs__prose">
                <Marked text={result.section.blurb} terms={terms} />
              </p>
            ) : (
              result.blocks.map((block, index) => (
                <DocsBlockView key={index} block={block} terms={terms} />
              ))
            )}
          </div>
        </section>
      ))}
    </>
  );
}

/** The searched-for words picked out of a line of documentation. */
function Marked({ text, terms }: { text: string; terms?: readonly string[] }) {
  if (!terms || terms.length === 0) return <>{text}</>;

  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Splitting on a capturing group leaves the captures at the odd indices,
  // which is what says whether a piece was matched or merely sits between two.
  const pieces = text.split(new RegExp(`(${escaped.join('|')})`, 'ig'));

  return (
    <>
      {pieces.map((piece, index) =>
        index % 2 === 1 ? (
          <mark key={index}>{piece}</mark>
        ) : (
          <Fragment key={index}>{piece}</Fragment>
        ),
      )}
    </>
  );
}

function DocsBlockView({
  block,
  terms,
  targetRow,
}: {
  block: DocsBlock;
  terms?: readonly string[];
  targetRow?: string | null;
}) {
  if (block.kind === 'prose') {
    return (
      <p className="docs__prose">
        <Marked text={block.text} terms={terms} />
      </p>
    );
  }

  if (block.kind === 'note') {
    return (
      <p className="docs__note">
        <Marked text={block.text} terms={terms} />
      </p>
    );
  }

  if (block.kind === 'steps') {
    return (
      <ol className="docs__steps">
        {block.items.map((item, index) => (
          <li key={index} className="docs__step">
            <Marked text={item} terms={terms} />
          </li>
        ))}
      </ol>
    );
  }

  return (
    <div className="docs__table-wrap">
      <table className="docs__table">
        <thead>
          <tr>
            <th scope="col">{block.head[0]}</th>
            <th scope="col">{block.head[1]}</th>
          </tr>
        </thead>
        <tbody>
          {/* Indexed, not keyed by the term: the keymap binds X and Delete
              once per mode, so the terms are not unique within a table. */}
          {block.rows.map(([term, description], index) => (
            <tr
              key={index}
              id={block.ids?.[index] ? rowAnchor(block.ids[index]) : undefined}
              className={
                targetRow && block.ids?.[index] === targetRow ? 'docs__row--target' : undefined
              }
            >
              <th scope="row">
                <Marked text={term} terms={terms} />
              </th>
              <td>
                <Marked text={description} terms={terms} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
