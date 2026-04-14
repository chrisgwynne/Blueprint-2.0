#!/usr/bin/env bun
/**
 * Dev script — runs the server and client dev servers in parallel.
 * Replaces `concurrently` to avoid the util._extend deprecation warning
 * that concurrently's spawn-command dependency emits on Node 20+.
 */

const RESET  = '\x1b[0m';
const BLUE   = '\x1b[34m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';

function tag(label, color) {
  return `${color}[${label}]${RESET} `;
}

function prefixLines(data, prefix) {
  return data.toString().split('\n').map(l => l ? prefix + l : '').join('\n');
}

async function runProcess(label, color, cmd, args, cwd) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  const prefix = tag(label, color);

  // Stream stdout and stderr with the label prefix
  async function pipe(stream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(prefixLines(Buffer.from(value), prefix) + '\n');
      }
    } catch {}
  }

  pipe(proc.stdout);
  pipe(proc.stderr);

  const code = await proc.exited;
  if (code !== 0 && code !== null) {
    process.stdout.write(`${tag(label, RED)}exited with code ${code}\n`);
  }
  return code;
}

const ROOT = new URL('..', import.meta.url).pathname;

// Start both in parallel
const results = await Promise.allSettled([
  runProcess('server', BLUE,   'bun', ['run', 'dev'], `${ROOT}server`),
  runProcess('client', YELLOW, 'bun', ['run', 'dev'], `${ROOT}client`),
]);

process.exit(results.some(r => r.status === 'rejected' || r.value) ? 1 : 0);
