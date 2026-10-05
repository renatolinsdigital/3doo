import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { installAutomation } from './app/automation/automation';
import { installRecorder } from './domain/scripting/recorder';

import './global-styles/index.scss';

// iOS zooms the page into any field it focuses that is set smaller than 16px,
// and leaves it zoomed after, which in an editor full of number fields is
// every tap. It honours a maximum scale for that jump while still letting the
// hand pinch to zoom, so capping it costs no one the zoom they ask for. Other
// browsers would hold the pinch to the cap as well, so it goes on iOS alone.
const ios =
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
if (ios) {
  const viewport = document.querySelector('meta[name="viewport"]');
  viewport?.setAttribute('content', `${viewport.getAttribute('content')}, maximum-scale=1`);
}

// What an assistant drives the editor through, by way of the MCP server.
installAutomation();

// Before the first render, so the cube a fresh tab opens on is the log's first line.
installRecorder();

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
