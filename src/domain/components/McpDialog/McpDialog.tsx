import { useEffect, useRef, useState } from 'react';

import { Button, Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import {
  HOSTED_URL,
  hostedClaudeCodeCommand,
  hostedClientConfig,
  REPOSITORY_URL,
  SERVER_PLACEHOLDER,
  claudeCodeCommand,
  clientConfig,
} from '../../mcp/guide';

import './McpDialog.scss';

/** The four links between an assistant and the API it ends up calling. */
const CHAIN: readonly { name: string; detail: string; link?: string }[] = [
  {
    name: 'YOUR ASSISTANT',
    detail: 'Claude Code, Claude Desktop or any other MCP client.',
    link: 'starts the server, then talks MCP to it over stdin and stdout',
  },
  {
    name: 'THE MCP SERVER',
    detail: 'node mcp/server.ts, running on your own computer.',
    link: 'opens 3DOO in a hidden browser, built locally or hosted',
  },
  {
    name: 'A HIDDEN 3DOO',
    detail: 'Headless Chrome or Chromium, with a scene of its own.',
    link: 'calls window.threedoo inside the page',
  },
  {
    name: 'THE SCRIPTING API',
    detail: 'The API of SCRIPT, so a script runs exactly as it does in this editor.',
  },
];

/**
 * How to use 3DOO as a tool for an AI assistant: what the MCP server is, how
 * it reaches the editor, and how to connect one to a local build or to the
 * hosted editor.
 */
export function McpDialog() {
  const open = useEditorStore((state) => state.dialog === 'mcp');
  const closeDialog = useEditorStore((state) => state.closeDialog);
  const appUrl = window.location.origin;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(appUrl);

  return (
    <Modal
      title="MCP SERVER"
      open={open}
      onClose={closeDialog}
      className="mcp-dialog"
      footer={
        <>
          <a
            className="mcp-dialog__docs"
            href="/docs#assistants"
            target="_blank"
            rel="noopener noreferrer"
          >
            AI ASSISTANTS DOCS ↗
          </a>
          <Button label="CLOSE" onClick={closeDialog} />
        </>
      }
    >
      <div className="mcp-dialog__lead">
        <p className="mcp-dialog__headline">LET AN AI ASSISTANT MODEL FOR YOU</p>
        <p className="mcp-dialog__pitch">
          3DOO comes with an MCP server. An assistant that speaks the Model Context Protocol, such
          as Claude, uses it to write and run scripts, look at what they built, and hand you the
          model as a file, as pictures, or as a link that opens it in this editor.
        </p>
      </div>

      <section className="mcp-dialog__section" aria-labelledby="mcp-connects">
        <h3 id="mcp-connects" className="mcp-dialog__heading">
          HOW IT CONNECTS
        </h3>
        <ol className="mcp-dialog__chain">
          {CHAIN.map((step) => (
            <li key={step.name} className="mcp-dialog__node">
              <span className="mcp-dialog__node-name">{step.name}</span>
              <span className="mcp-dialog__node-detail">{step.detail}</span>
              {step.link ? <span className="mcp-dialog__node-link">↓ {step.link}</span> : null}
            </li>
          ))}
        </ol>
        <p className="mcp-dialog__note">
          The server always runs on your computer, never on this website, and its 3DOO is not this
          tab: it cannot see or change the scene in front of you. To bring a model here, ask for a
          link or a .3doo file. Where that hidden 3DOO comes from is your choice, below.
        </p>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-modes">
        <h3 id="mcp-modes" className="mcp-dialog__heading">
          LOCAL OR HOSTED
        </h3>
        <div className="mcp-dialog__modes">
          <div className="mcp-dialog__mode">
            <span className="mcp-dialog__mode-name">LOCAL</span>
            <p className="mcp-dialog__text">
              The server draws in a copy of 3DOO you built on your own computer.
            </p>
            <ul>
              <li>Builds, renders and exports work with no internet connection.</li>
              <li>The 3DOO it uses is always the same version as the server.</li>
              <li>Needs the code built once, and again after you change it.</li>
              <li>
                Links open on the address you set. One to localhost opens only on your computer,
                while 3DOO is served there.
              </li>
            </ul>
          </div>
          <div className="mcp-dialog__mode">
            <span className="mcp-dialog__mode-name">HOSTED</span>
            <p className="mcp-dialog__text">
              The server draws in the hosted 3DOO at {HOSTED_URL.replace('https://', '')}.
            </p>
            <ul>
              <li>Nothing to download or build: one command adds the published server.</li>
              <li>Needs the internet, since the hidden browser loads the editor from the web.</li>
              <li>
                Links open on the hosted editor, so they work on any computer and for anyone you
                send them to.
              </li>
              <li>
                The hosted editor has to be on the same version as the server, or the first call
                says which one to update.
              </li>
            </ul>
          </div>
        </div>
        <p className="mcp-dialog__note">
          Either way the server runs on your computer, so files and pictures are saved there, and
          the scene the assistant builds is private to it.
        </p>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-setup">
        <h3 id="mcp-setup" className="mcp-dialog__heading">
          SET IT UP
        </h3>
        <ol className="mcp-dialog__steps">
          <li>
            <p>
              Both ways need Node 22.18 or newer, and Chrome, Edge or Chromium to draw the models
              in. With neither Chrome nor Edge installed, fetch a Chromium of its own:
            </p>
            <CopyBlock
              label="Command to install Chromium"
              text="npx playwright-core install chromium"
            />
          </li>
          <li>
            <p>
              <strong>HOSTED:</strong> nothing to download. Add the server to your assistant and it
              fetches the published package itself the first time it starts. In Claude Code:
            </p>
            <CopyBlock label="Claude Code command, hosted" text={hostedClaudeCodeCommand()} />
            <p>
              In Claude Desktop, or any client set up by a JSON file, add the entry under{' '}
              <code>mcpServers</code> (for Claude Desktop, in claude_desktop_config.json):
            </p>
            <CopyBlock label="Client configuration, hosted" text={hostedClientConfig()} />
          </li>
          <li>
            <p>
              <strong>LOCAL:</strong> get the code, build it, then add the server with the path to
              your copy in place of <code>{SERVER_PLACEHOLDER}</code>.{' '}
              <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
                Source on GitHub ↗
              </a>
            </p>
            <CopyBlock
              label="Commands to get and build the code"
              text={`git clone ${REPOSITORY_URL}.git\ncd 3doo\nnpm install\nnpm run build`}
            />
            <CopyBlock label="Claude Code command, local" text={claudeCodeCommand(appUrl)} />
            {isLocal ? (
              <p>
                This page is on your own computer, so the links the assistant makes point at{' '}
                <code>{appUrl}</code> and open only while 3DOO is served there. Use the hosted
                address in place of it for links that work anywhere.
              </p>
            ) : null}
            <CopyBlock label="Client configuration, local" text={clientConfig(appUrl)} />
          </li>
          <li>
            <p>
              Ask for a model: &ldquo;Build a low poly chair in 3DOO, show me the front and side
              views, then export it as FBX for Unity.&rdquo;
            </p>
          </li>
        </ol>
        <p className="mcp-dialog__note">
          The assistant starts the server by itself the moment it needs it, and stops it when it
          closes. Once it is added, you never start or stop anything to use it.
        </p>
      </section>
    </Modal>
  );
}

interface CopyBlockProps {
  /** What the block holds, for a screen reader and for the copy button's name. */
  label: string;
  text: string;
}

/** A command or a configuration to paste elsewhere, with a button that copies it. */
function CopyBlock({ label, text }: CopyBlockProps) {
  const block = useRef<HTMLPreElement>(null);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'blocked'>('idle');

  useEffect(() => {
    if (copy !== 'copied') return;
    const timer = window.setTimeout(() => setCopy('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      // The clipboard API is missing outside a secure context and a browser
      // may refuse it. With the text selected, the copy shortcut still works.
      const selection = window.getSelection();
      if (block.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(block.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopy('blocked');
    }
  };

  return (
    <div className="mcp-dialog__copy">
      <pre ref={block} className="mcp-dialog__code" aria-label={label}>
        {text}
      </pre>
      <Button
        label={copy === 'copied' ? 'COPIED' : 'COPY'}
        aria-label={`Copy: ${label}`}
        className="mcp-dialog__copy-button"
        onClick={() => void copyText()}
      />
      {copy === 'blocked' ? (
        <p className="mcp-dialog__status" role="status">
          The browser blocked copying, so the text is selected: press your copy shortcut.
        </p>
      ) : null}
    </div>
  );
}
