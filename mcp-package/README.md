# 3doo-mcp

An MCP server that lets an AI assistant build 3D models in [3DOO](https://3doo.vercel.app)
with its scripting API, look at them, and hand them back as `.3doo`, OBJ or FBX
files, PNG pictures, or a page that opens the editor on the model.

A good way to start is to ask the assistant for a first version, then open the
page it saves, press OPEN IN 3DOO and refine the model by hand in the browser
editor.

It needs Node 22 or newer, and a Chrome, Edge or Chromium on the machine
(otherwise run `npx playwright-core install chromium`). It draws models in the
hosted editor, so it needs the internet.

Claude Code:

```bash
claude mcp add 3doo -e THREEDOO_APP_URL=https://3doo.vercel.app -- npx -y 3doo-mcp
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "3doo": {
      "command": "npx",
      "args": ["-y", "3doo-mcp"],
      "env": { "THREEDOO_APP_URL": "https://3doo.vercel.app" }
    }
  }
}
```

Settings, tools and what each returns are in
[docs/mcp.md](https://github.com/renatolinsdigital/3doo/blob/master/docs/mcp.md).


## Tips for Better AI + Browser App Workflows

1. Start with a prompt: Describe the scene or model you want and let the assistant build the first version in 3DOO.

2. Refine in the editor: Open the model in 3DOO to adjust objects and modifiers manually.

3. If necessary, share the project for AI new edits: Save a copy as a `.3doo` file and ask the assistant to modify specific parts. Attach screenshots or drawings for better results.

4. If your edits comes from AI only: Keep the `.3doo` file in a known folder, tell the assistant its path, and ask it to save changes there. Reopen the file in 3DOO to review the result.

## Support 3DOO

3DOO and this server are free. If they save you time, a donation pays for the
hours behind the next release.

- **[Donate with PayPal](https://www.paypal.com/donate/?business=renato.digital.crafts%40gmail.com&currency_code=USD&item_name=Support+3DOO)**,
  any amount.
- Or send it from your own PayPal app to `renato.digital.crafts@gmail.com`.

PayPal takes the payment, so 3DOO never sees your card or account.

## License

MIT
