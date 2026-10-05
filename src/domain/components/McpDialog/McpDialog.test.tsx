import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useEditorStore } from '@store/index';

import { MCP_SETTINGS, MCP_TOOLS } from '../../mcp/guide';

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

  it('lists every tool the server gives an assistant, and what each returns', () => {
    render(<McpDialog />);

    const table = screen.getByRole('heading', { name: 'TOOLS IT GIVES THE ASSISTANT' })
      .nextElementSibling as HTMLElement;
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) => within(row).getByRole('rowheader').querySelector('code')?.textContent),
    ).toEqual(MCP_TOOLS.map((tool) => tool.name));
    expect(within(rows[1]).getByText(/names the line and changes nothing/)).toBeInTheDocument();
  });

  it('lists every setting the server reads', () => {
    render(<McpDialog />);
    for (const setting of MCP_SETTINGS) {
      expect(screen.getAllByText(setting.name, { selector: 'code' }).length).toBeGreaterThan(0);
    }
  });

  it('fills in this site as the place links open', () => {
    render(<McpDialog />);
    const command = screen.getByLabelText('Claude Code command');
    expect(command.textContent).toBe(
      `claude mcp add 3doo -e THREEDOO_APP_URL=${window.location.origin} -- node /path/to/3doo/mcp/server.ts`,
    );
    expect(JSON.parse(screen.getByLabelText('Client configuration').textContent ?? '')).toEqual({
      mcpServers: {
        '3doo': {
          command: 'node',
          args: ['/path/to/3doo/mcp/server.ts'],
          env: { THREEDOO_APP_URL: window.location.origin },
        },
      },
    });
  });

  it('says which commands to run and when, and that the assistant starts the server', () => {
    render(<McpDialog />);
    const table = screen.getByRole('heading', { name: 'WHAT YOU RUN, AND WHEN' })
      .nextElementSibling as HTMLElement;
    const commands = within(table)
      .getAllByRole('rowheader')
      .map((cell) => cell.textContent);
    expect(commands).toEqual(['npm run build', 'claude mcp add 3doo ...', 'npm run dev', 'npm run mcp']);
    expect(screen.getByText(/starts the server by itself/)).toBeInTheDocument();
  });

  it('warns that links to localhost open only while the app is served', () => {
    render(<McpDialog />);
    expect(screen.getByText(/open only while 3DOO is served there/)).toBeInTheDocument();
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
