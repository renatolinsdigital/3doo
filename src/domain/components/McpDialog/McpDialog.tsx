import { useEffect, useRef, useState } from 'react';

import { Button, Modal } from '@shared/components';
import { useEditorStore } from '@store/index';

import {
  MCP_SETTINGS,
  MCP_TOOLS,
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
    link: 'opens the built app in a hidden browser',
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

const COMMANDS: readonly { name: string; when: string }[] = [
  {
    name: 'npm run build',
    when: 'Once, and again after you change the code. The server draws its models from the built app, so this is the only 3DOO it needs.',
  },
  {
    name: 'claude mcp add 3doo ...',
    when: 'Once, to tell your assistant the server exists. Copy it from SET IT UP below.',
  },
  {
    name: 'npm run dev',
    when: 'Not needed to build models. Only a link that points at localhost needs it, and that link opens only while it runs.',
  },
  {
    name: 'npm run mcp',
    when: 'Never in normal use. It starts the server by hand, which only helps when you debug it.',
  },
];

const SAMPLE_RESULT =`Script ran: 1 object added

Scene: {"name":"untitled","totals":{"objects":1,"vertices":8,"faces":6},"bounds":{"min":{"x":-1,"y":0.95,"z":-0.5},"max":{"x":1,"y":1.05,"z":0.5},"size":{"x":2,"y":0.1,"z":1}}}
Objects (1):
{"name":"TOP","vertices":8,"edges":12,"faces":6,"position":{"x":0,"y":1,"z":0},"rotation":{"x":0,"y":0,"z":0},"scale":{"x":2,"y":0.1,"z":1},"dimensions":{"x":2,"y":0.1,"z":1},"color":"#b8452f","modifiers":[],"visible":true,"group":null}`;

/**
 * How to use 3DOO as a tool for an AI assistant: what the MCP server is, how
 * it reaches the editor, how to connect one, and what comes back.
 *
 * The commands carry this page's own address as the place links open, so
 * someone setting up from the hosted editor gets links back to it.
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
          The server runs on your computer, not on this website, and its 3DOO is not this tab: it
          cannot see or change the scene in front of you. To bring a model here, ask for a link or a
          .3doo file.
        </p>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-run">
        <h3 id="mcp-run" className="mcp-dialog__heading">
          WHAT YOU RUN, AND WHEN
        </h3>
        <table className="mcp-dialog__table">
          <thead>
            <tr>
              <th scope="col">COMMAND</th>
              <th scope="col">WHEN</th>
            </tr>
          </thead>
          <tbody>
            {COMMANDS.map((command) => (
              <tr key={command.name}>
                <th scope="row">
                  <code>{command.name}</code>
                </th>
                <td data-label="WHEN">{command.when}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mcp-dialog__note">
          The assistant starts the server by itself the moment it needs it, and stops it when it
          closes. Once it is added, you never start or stop anything to use it.
        </p>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-setup">
        <h3 id="mcp-setup" className="mcp-dialog__heading">
          SET IT UP
        </h3>
        <ol className="mcp-dialog__steps">
          <li>
            <p>
              Get the code and build it. It needs Node 22.18 or newer.{' '}
              <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer">
                Source on GitHub ↗
              </a>
            </p>
            <CopyBlock
              label="Commands to get and build the code"
              text={`git clone ${REPOSITORY_URL}.git\ncd 3doo\nnpm install\nnpm run build`}
            />
          </li>
          <li>
            <p>
              The server draws the models in Chrome, Edge or Chromium. With neither Chrome nor Edge
              installed, fetch a Chromium of its own:
            </p>
            <CopyBlock
              label="Command to install Chromium"
              text="npx playwright-core install chromium"
            />
          </li>
          <li>
            <p>
              Add the server to your assistant, with the path to your copy in place of{' '}
              <code>{SERVER_PLACEHOLDER}</code>. In Claude Code:
            </p>
            <CopyBlock label="Claude Code command" text={claudeCodeCommand(appUrl)} />
            {isLocal ? (
              <p>
                This page is on your own computer, so the links the assistant makes point at{' '}
                <code>{appUrl}</code> and open only while 3DOO is served there. For links that work
                anywhere, put the address of a hosted 3DOO in place of it.
              </p>
            ) : null}
            <p>
              In Claude Desktop, or any client set up by a JSON file, add the entry under{' '}
              <code>mcpServers</code> (for Claude Desktop, in claude_desktop_config.json):
            </p>
            <CopyBlock label="Client configuration" text={clientConfig(appUrl)} />
          </li>
          <li>
            <p>
              Ask for a model: &ldquo;Build a low poly chair in 3DOO, show me the front and side
              views, then export it as FBX for Unity.&rdquo;
            </p>
          </li>
        </ol>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-tools">
        <h3 id="mcp-tools" className="mcp-dialog__heading">
          TOOLS IT GIVES THE ASSISTANT
        </h3>
        <table className="mcp-dialog__table">
          <thead>
            <tr>
              <th scope="col">TOOL</th>
              <th scope="col">DOES</th>
              <th scope="col">RETURNS</th>
            </tr>
          </thead>
          <tbody>
            {MCP_TOOLS.map((tool) => (
              <tr key={tool.name}>
                <th scope="row">
                  <code>{tool.name}</code>
                  {tool.args.length > 0 ? (
                    <span className="mcp-dialog__args">{tool.args.join(', ')}</span>
                  ) : null}
                </th>
                <td data-label="DOES">{tool.does}</td>
                <td data-label="RETURNS">{tool.returns}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-returns">
        <h3 id="mcp-returns" className="mcp-dialog__heading">
          WHAT COMES BACK
        </h3>
        <p className="mcp-dialog__text">
          After every script the assistant reads the scene back as text, one line per object, in
          metres and degrees, with the counts of the shape as drawn and exported:
        </p>
        <pre className="mcp-dialog__sample">{SAMPLE_RESULT}</pre>
        <p className="mcp-dialog__text">
          Pictures come back as images it can look at before it answers you. Files are written to
          the output folder on your computer, and the reply says where. A link opens this editor
          with the model in it, unsaved, ready to keep working on.
        </p>
      </section>

      <section className="mcp-dialog__section" aria-labelledby="mcp-settings">
        <h3 id="mcp-settings" className="mcp-dialog__heading">
          SETTINGS
        </h3>
        <p className="mcp-dialog__text">
          Environment variables the server reads as it starts. Pass them with -e in Claude Code, or
          under env in a JSON configuration.
        </p>
        <table className="mcp-dialog__table">
          <thead>
            <tr>
              <th scope="col">VARIABLE</th>
              <th scope="col">DEFAULT</th>
              <th scope="col">MEANS</th>
            </tr>
          </thead>
          <tbody>
            {MCP_SETTINGS.map((setting) => (
              <tr key={setting.name}>
                <th scope="row">
                  <code>{setting.name}</code>
                </th>
                <td data-label="DEFAULT">{setting.fallback}</td>
                <td data-label="MEANS">{setting.means}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
