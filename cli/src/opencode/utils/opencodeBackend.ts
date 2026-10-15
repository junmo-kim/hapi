import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildOpencodeEnv } from './config';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

/**
 * Detects whether the installed `opencode` binary speaks the v1 (≤1.x) or
 * v2 (≥2.x) CLI contract. v2 dropped the `opencode acp` `--cwd/--port/
 * --hostname` flags and redesigned the internal HTTP API (see the
 * opencode-v2-compat plan), so the launcher needs the major version before
 * spawning. Runs `command --version` (5s timeout) and parses the first
 * `v?N.` from stdout; any spawn failure, timeout or unparseable output
 * falls back to 'v1' — the pre-v2-aware behavior.
 */
export async function detectOpencodeFlavorVersion(command = 'opencode'): Promise<'v1' | 'v2'> {
    try {
        const stdout = await new Promise<string>((resolve, reject) => {
            const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error('opencode --version timed out'));
            }, 5000);
            child.stdout?.on('data', (chunk) => {
                out += String(chunk);
            });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
            child.on('close', () => {
                clearTimeout(timer);
                resolve(out);
            });
        });
        const match = /v?(\d+)\./.exec(stdout);
        const major = match ? Number.parseInt(match[1]!, 10) : Number.NaN;
        return major === 2 ? 'v2' : 'v1';
    } catch {
        return 'v1';
    }
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Reserves a free TCP port on the given loopback host by binding an
 * ephemeral probe socket (`listen(0)`) and immediately closing it before
 * resolving. `opencode acp` does not announce the port it actually bound
 * when launched with `--port 0` (verified 2026-07-30 — no port appears in
 * stdout/stderr even at DEBUG log level), so HAPI must pick the port itself
 * and hand it to the subprocess explicitly via `--port`. There is a
 * theoretical reuse race between this function releasing the port and the
 * subprocess binding it, but both sides are loopback-only local processes,
 * so the practical risk is low.
 */
export function allocateFreePort(hostname = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, hostname, () => {
            const address = probe.address();
            const port = address && typeof address === 'object' ? address.port : null;
            probe.close((closeError) => {
                if (closeError) {
                    reject(closeError);
                    return;
                }
                if (port === null) {
                    reject(new Error('Failed to allocate a free port for the OpenCode ACP server'));
                    return;
                }
                resolve(port);
            });
        });
    });
}

export function createOpencodeBackend(opts: {
    cwd?: string;
    port?: number;
    hostname?: string;
}): AcpSdkBackend {
    const env = buildOpencodeEnv();
    const args = ['acp', '--cwd', opts.cwd ?? getInvokedCwd()];
    if (opts.port !== undefined) {
        args.push('--port', String(opts.port));
    }
    if (opts.hostname !== undefined) {
        args.push('--hostname', opts.hostname);
    }

    return new AcpSdkBackend({
        command: getAgentLaunchCommand('opencode'),
        args,
        env: filterEnv(env),
        textChunkMode: 'delta',
        flavor: 'opencode',
    });
}
