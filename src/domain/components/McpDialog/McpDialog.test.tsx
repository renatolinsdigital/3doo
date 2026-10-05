import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { HOSTED_URL } from '../../mcp/guide';

import { McpDialog } from './McpDialog';

const store = () => useEditorStore.getState();

describe('McpDialog', () => {
  beforeEach(() => {
    store().openDialog('mcp');
  });

  it('stays closed until the top bar opens it', () => {
    store().closeDialog();
    render(<McpDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('holds no tables: those belong to the app docs', () => {
    render(<McpDialog />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('explains what local and hosted each mean', () => {
    render(<McpDialog />);
    expect(screen.getByRole('heading', { name: 'LOCAL OR HOSTED' })).toBeInTheDocument();
    expect(screen.getByText(/work with no internet connection/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing to download or build/)).toBeInTheDocument();
  });

  it('fills in this site as the place links open for a local build', () => {
    render(<McpDialog />);
    const command = screen.getByLabelText('Claude Code command, local');
    expect(command.textContent).toBe(
      `claude mcp add 3doo -e THREEDOO_APP_URL=${window.location.origin} -- node /path/to/3doo/mcp/server.ts`,
    );
    expect(
      JSON.parse(screen.getByLabelText('Client configuration, local').textContent ?? ''),
    ).toEqual({
      mcpServers: {
        '3doo': {
          command: 'node',
          args: ['/path/to/3doo/mcp/server.ts'],
          env: { THREEDOO_APP_URL: window.location.origin },
        },
      },
    });
  });

  it('runs the published package for the hosted setup, with no code to download', () => {
    render(<McpDialog />);
    expect(screen.getByLabelText('Claude Code command, hosted').textContent).toBe(
      `claude mcp add 3doo -e THREEDOO_APP_URL=${HOSTED_URL} -- npx -y 3doo-mcp`,
    );
    expect(
      JSON.parse(screen.getByLabelText('Client configuration, hosted').textContent ?? ''),
    ).toEqual({
      mcpServers: {
        '3doo': {
          command: 'npx',
          args: ['-y', '3doo-mcp'],
          env: { THREEDOO_APP_URL: HOSTED_URL },
        },
      },
    });
  });

  it('says the assistant starts the server', () => {
    render(<McpDialog />);
    expect(screen.getByText(/starts the server by itself/)).toBeInTheDocument();
  });

  it('warns that links to localhost open only while the app is served', () => {
    render(<McpDialog />);
    expect(screen.getAllByText(/open only while 3DOO is served there/).length).toBeGreaterThan(0);
  });

  it('copies a command and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<McpDialog />);

    await user.click(screen.getByRole('button', { name: 'Copy: Command to install Chromium' }));

    expect(writeText).toHaveBeenCalledWith('npx playwright-core install chromium');
    expect(
      screen.getByRole('button', { name: 'Copy: Command to install Chromium' }),
    ).toHaveTextContent('COPIED');
  });

  it('selects the text for the copy shortcut when the browser refuses the clipboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<McpDialog />);

    await user.click(screen.getByRole('button', { name: 'Copy: Command to install Chromium' }));

    expect(window.getSelection()?.toString()).toBe('npx playwright-core install chromium');
    expect(screen.getByRole('status')).toHaveTextContent(/press your copy shortcut/);
  });

  it('closes from its own button', async () => {
    render(<McpDialog />);
    await userEvent.click(screen.getByRole('button', { name: 'CLOSE' }));
    expect(store().dialog).toBeNull();
  });
});
