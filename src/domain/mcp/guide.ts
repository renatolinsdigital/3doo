/**
 * The MCP server as the editor describes it, to the MCP dialog and the AI
 * ASSISTANTS docs.
 *
 * The server lives in `mcp/` and runs in Node, where the app cannot import it.
 * A test there holds these lists to the server's own, tool by tool, argument
 * by argument and setting by setting, so the editor cannot describe a server
 * other than the one in the repository.
 */

export const REPOSITORY_URL = 'https://github.com/renatolinsdigital/3doo';

/** Where the server is, as the setup commands write it until the reader puts in their own. */
export const SERVER_PLACEHOLDER = '/path/to/3doo/mcp/server.ts';

export interface McpToolGuide {
  name: string;
  /** Its arguments, as the server's input schema names them. */
  args: readonly string[];
  /** What it is for, in the words a person would ask for it in. */
  does: string;
  /** What the assistant gets back. */
  returns: string;
}

export const MCP_TOOLS: readonly McpToolGuide[] = [
  {
    name: 'scripting_reference',
    args: ['topic', 'example'],
    does: 'Hands the assistant the scripting reference, which it reads before its first script. By default that is a short quickstart; the full API and the finished examples are fetched only when needed.',
    returns:
      'Markdown: the conventions, a script that runs, every name and the rules a table does not say. With topic api, every option and range; with example, one finished model.',
  },
  {
    name: 'run_script',
    args: ['script', 'reset'],
    does: 'Runs a script against the scene with the API of SCRIPT. The scene carries over from one call to the next; reset starts from an empty one.',
    returns:
      "What the run did, whatever the script returned or logged, and the scene: each object's counts, position, rotation, scale, size, colour and modifiers. A run that fails names the line and changes nothing.",
  },
  {
    name: 'render_views',
    args: ['views', 'width', 'height', 'shading', 'projection', 'grid', 'save', 'name'],
    does: 'Takes pictures of the model, drawn the way the viewport draws it: in perspective, or straight on from the front, back, sides, top or bottom.',
    returns: 'One PNG per view, and a file of each when save is on.',
  },
  {
    name: 'export_model',
    args: ['format', 'name', 'preset', 'triangulate', 'directory', 'embed'],
    does: 'Writes the model as a .3doo project, an OBJ with its .mtl, or a binary FBX, set up for Unity, Unreal, Blender or Maya.',
    returns: 'The path of every file written and a link to each. With embed, the files themselves.',
  },
  {
    name: 'share_link',
    args: ['app_url'],
    does: 'Makes a link that opens this editor on the model. The whole scene travels inside the link, so nothing is uploaded.',
    returns: 'The link.',
  },
  {
    name: 'open_file',
    args: ['path'],
    does: 'Opens a .3doo in place of the scene, or imports an OBJ or FBX into it, to work on a model you already have.',
    returns: 'The scene, as run_script describes it.',
  },
  {
    name: 'get_scene',
    args: [],
    does: 'Describes what is in the scene, without changing it.',
    returns: 'The scene, as run_script describes it.',
  },
];

export interface McpSetting {
  name: string;
  fallback: string;
  means: string;
}

/** The server's environment variables, read once as it starts. */
export const MCP_SETTINGS: readonly McpSetting[] = [
  {
    name: 'THREEDOO_APP_URL',
    fallback: 'none',
    means: 'Where 3DOO is hosted. Links open there, so set it for share_link.',
  },
  {
    name: 'THREEDOO_OUTPUT_DIR',
    fallback: '3doo-output in your home folder',
    means: 'Where exports and saved pictures go, and what relative paths are read against.',
  },
  {
    name: 'THREEDOO_ENGINE_URL',
    fallback: 'none',
    means:
      'A running 3DOO to drive instead of the built one, such as npm run dev at http://localhost:5173.',
  },
  {
    name: 'THREEDOO_CHROMIUM',
    fallback: 'none',
    means: 'A Chrome or Chromium to launch, when the server finds none of its own.',
  },
  {
    name: 'THREEDOO_TIMEOUT_MS',
    fallback: '60000',
    means: 'How long one call may run, in milliseconds, before it is stopped.',
  },
];

/** The command that adds the server to Claude Code, pointing links at `appUrl`. */
export function claudeCodeCommand(appUrl: string, server = SERVER_PLACEHOLDER): string {
  return `claude mcp add 3doo -e THREEDOO_APP_URL=${appUrl} -- node ${server}`;
}

/** The `mcpServers` entry for a client configured by a JSON file, such as Claude Desktop. */
export function clientConfig(appUrl: string, server = SERVER_PLACEHOLDER): string {
  const entry = { command: 'node', args: [server], env: { THREEDOO_APP_URL: appUrl } };
  return JSON.stringify({ mcpServers: { '3doo': entry } }, null, 2);
}
