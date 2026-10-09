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

## License

MIT
