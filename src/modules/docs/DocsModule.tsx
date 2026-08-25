import { useEffect, useState } from 'react';

import { ModuleSwitcher } from '@app/ModuleSwitcher/ModuleSwitcher';
import { navigate } from '@app/router';
import { Button } from '@shared/components';

import { type DocsBlock, DOCS_SECTIONS } from './content';

import './DocsModule.scss';

/** The section named by the URL fragment, falling back to the first one. */
function sectionFromHash(): string {
  const id = window.location.hash.replace('#', '');
  return DOCS_SECTIONS.some((section) => section.id === id) ? id : DOCS_SECTIONS[0].id;
}

export function DocsModule() {
  const [activeId, setActiveId] = useState(sectionFromHash);
  const active = DOCS_SECTIONS.find((section) => section.id === activeId) ?? DOCS_SECTIONS[0];

  // The fragment is what makes a section linkable. Replaced rather than pushed,
  // so reading through the docs does not bury the previous module under a dozen
  // back-button steps.
  useEffect(() => {
    window.history.replaceState(null, '', `/docs#${activeId}`);
  }, [activeId]);

  useEffect(() => {
    const onHashChange = () => setActiveId(sectionFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div className="docs">
      <header className="docs__bar">
        <ModuleSwitcher />
        <Button label="OPEN MODELING" variant="primary" onClick={() => navigate('/modeling')} />
      </header>

      <div className="docs__body">
        <nav className="docs__nav" aria-label="Documentation">
          <p className="docs__nav-title">CONTENTS</p>
          {DOCS_SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              className="docs__nav-item"
              aria-current={section.id === active.id ? 'page' : undefined}
              onClick={() => setActiveId(section.id)}
            >
              <span className="docs__nav-label">{section.title}</span>
              <span className="docs__nav-blurb">{section.blurb}</span>
            </button>
          ))}
        </nav>

        <main className="docs__content" key={active.id}>
          <h1 className="docs__title">{active.title}</h1>
          <p className="docs__blurb">{active.blurb}</p>
          {active.blocks.map((block, index) => (
            <DocsBlockView key={index} block={block} />
          ))}
        </main>
      </div>
    </div>
  );
}

function DocsBlockView({ block }: { block: DocsBlock }) {
  if (block.kind === 'prose') {
    return <p className="docs__prose">{block.text}</p>;
  }

  if (block.kind === 'note') {
    return <p className="docs__note">{block.text}</p>;
  }

  if (block.kind === 'steps') {
    return (
      <ol className="docs__steps">
        {block.items.map((item, index) => (
          <li key={index} className="docs__step">
            {item}
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
            <tr key={index}>
              <th scope="row">{term}</th>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
