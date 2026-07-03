import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function getFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

test('preview server returns 404 for missing files without crashing', async () => {
  const port = await getFreePort();
  const script = `
    import { startPreviewTool } from './src/tools/tools.ts';

    await startPreviewTool.execute({ port: ${port} });
    const res = await fetch('http://127.0.0.1:${port}/missing.ico');
    if (res.status !== 404) {
      throw new Error('Expected 404, got ' + res.status);
    }
    process.exit(0);
  `;

  const child = spawn(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0, `child exited with ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
});
