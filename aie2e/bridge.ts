import { connect } from 'node:net';

/**
 * What each agent session launches as its 3doo MCP server: a pipe from its
 * stdio to the run's scene hub on a local port. Every session then works on
 * the one scene the hub holds, rather than each on an empty one of its own.
 *
 * Run as `node aie2e/bridge.ts <port>`.
 */

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('[aie2e bridge] usage: node aie2e/bridge.ts <port>\n');
  process.exit(2);
}

const socket = connect(port, '127.0.0.1');
process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.on('close', () => process.exit(0));
socket.on('error', (error) => {
  process.stderr.write(`[aie2e bridge] ${error.message}\n`);
  process.exit(1);
});
