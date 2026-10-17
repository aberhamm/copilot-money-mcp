/**
 * Unit tests for the CLI entry point (src/cli.ts).
 *
 * Since parseArgs, configureLogging, and main are module-private,
 * we test via subprocess spawning using Bun.spawn.
 */

import { describe, test, expect } from 'bun:test';

const CLI_PATH = new URL('../../src/cli.ts', import.meta.url).pathname;

/** Default timeout for spawned processes (ms). */
const PROC_TIMEOUT_MS = 3_000;

/**
 * Spawn `bun run src/cli.ts` with the given args, wait up to
 * PROC_TIMEOUT_MS, then kill and return { exitCode, stdout, stderr }.
 */
async function runCli(
  args: string[] = [],
  env: Record<string, string | undefined> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI_PATH, ...args], {
    // Start from a clean selection so the developer's own COPILOT_BROWSER*
    // never leaks into these tests; `env` then adds what a test sets.
    env: { ...process.env, COPILOT_BROWSER: '', COPILOT_BROWSER_PROFILE: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    // Don't provide stdin so the server has nothing to read from
    stdin: 'ignore',
  });

  // Race the process against a timeout
  const timeout = setTimeout(() => {
    proc.kill();
  }, PROC_TIMEOUT_MS);

  const exitCode = await proc.exited;
  clearTimeout(timeout);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { exitCode, stdout, stderr };
}

describe('CLI entry point', () => {
  describe('--help / -h', () => {
    test('--help prints help text and exits with code 0', async () => {
      const { exitCode, stderr } = await runCli(['--help']);

      expect(exitCode).toBe(0);
      expect(stderr).toContain('Copilot Money MCP Server');
    });

    test('-h prints help text and exits with code 0', async () => {
      const { exitCode, stderr } = await runCli(['-h']);

      expect(exitCode).toBe(0);
      expect(stderr).toContain('Copilot Money MCP Server');
    });
  });

  describe('--timeout', () => {
    test('valid timeout value does not produce a parse error', async () => {
      const { stderr } = await runCli(['--timeout', '5000']);

      expect(stderr).not.toContain('Invalid --timeout');
    });

    test('invalid timeout "abc" prints error and exits with code 1', async () => {
      const { exitCode, stderr } = await runCli(['--timeout', 'abc']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid --timeout value: abc');
    });

    test('invalid timeout "0" prints error and exits with code 1', async () => {
      const { exitCode, stderr } = await runCli(['--timeout', '0']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid --timeout value: 0');
    });

    test('invalid timeout "-5" prints error and exits with code 1', async () => {
      const { exitCode, stderr } = await runCli(['--timeout', '-5']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Invalid --timeout value: -5');
    });

    test('--timeout at end of args without value does not crash', async () => {
      // When --timeout is the last arg, there's no following value.
      // The condition `i + 1 < args.length` is false, so --timeout is
      // silently ignored. The process should not crash on arg parsing.
      const { stderr } = await runCli(['--timeout']);

      expect(stderr).not.toContain('Invalid --timeout');
    });
  });

  describe('--db-path', () => {
    test('--db-path with a custom path produces no parse error', async () => {
      const { stderr } = await runCli(['--db-path', '/tmp/fake-db']);

      // Only check for arg-parsing errors; the server may log
      // "Server error: ..." to stderr when runServer() throws on EOF.
      expect(stderr).not.toContain('Invalid --db-path');
    });
  });

  describe('--verbose / -v', () => {
    test('--verbose enables verbose logging output', async () => {
      const { stderr } = await runCli(['--verbose']);

      // Verbose mode prefixes log lines with [LOG] or [ERROR]
      expect(stderr).toContain('[LOG]');
      expect(stderr).toContain('Starting Copilot Money MCP Server');
    });

    test('-v enables verbose logging output', async () => {
      const { stderr } = await runCli(['-v']);

      expect(stderr).toContain('[LOG]');
      expect(stderr).toContain('Starting Copilot Money MCP Server');
    });
  });

  describe('--write', () => {
    test('--write flag produces no parse error', async () => {
      const { stderr } = await runCli(['--write']);

      expect(stderr).not.toContain('Invalid');
    });

    test('--write does not print a "temporarily unavailable" notice', async () => {
      const { stderr } = await runCli(['--write']);

      expect(stderr).not.toContain('temporarily unavailable');
    });

    test('--write -v logs that both write tools and live reads are enabled', async () => {
      const { stderr } = await runCli(['--write', '-v']);

      expect(stderr).toContain('Write tools enabled');
      expect(stderr).toContain('Live reads enabled');
    });

    test('--live-reads alone does NOT enable write tools', async () => {
      const { stderr } = await runCli(['--live-reads', '-v']);

      expect(stderr).toContain('Live reads enabled');
      expect(stderr).not.toContain('Write tools enabled');
    });

    test('explicit --write --live-reads behaves the same as --write alone', async () => {
      const { stderr } = await runCli(['--write', '--live-reads', '-v']);

      expect(stderr).toContain('Write tools enabled');
      expect(stderr).toContain('Live reads enabled');
    });
  });

  describe('no arguments', () => {
    test('starts server without arg parsing errors', async () => {
      const { stderr } = await runCli([]);

      // Should not contain any argument parsing errors
      expect(stderr).not.toContain('Invalid');
      expect(stderr).not.toContain('Usage');
    });
  });

  describe('--browser / --browser-profile', () => {
    test('--help documents the flags, the env vars and the valid names', async () => {
      const { exitCode, stderr } = await runCli(['--help']);

      expect(exitCode).toBe(0);
      expect(stderr).toContain('--browser <name>');
      expect(stderr).toContain('--browser-profile <name>');
      expect(stderr).toContain('COPILOT_BROWSER');
      expect(stderr).toContain('COPILOT_BROWSER_PROFILE');
      expect(stderr).toContain('opera-gx');
    });

    test('an unknown --browser exits 1 listing the valid names', async () => {
      const { exitCode, stderr } = await runCli(['--browser', 'netscape', '--live-reads']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown browser "netscape"');
      expect(stderr).toContain('chrome, arc, edge, brave');
    });

    test('an unknown COPILOT_BROWSER exits 1 too', async () => {
      const { exitCode, stderr } = await runCli(['--live-reads'], { COPILOT_BROWSER: 'netscape' });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Unknown browser "netscape"');
    });

    test('the --browser flag wins over COPILOT_BROWSER', async () => {
      // A bad flag fails even though the env var names a valid browser…
      const flagBad = await runCli(['--browser', 'netscape'], { COPILOT_BROWSER: 'brave' });
      expect(flagBad.exitCode).toBe(1);
      expect(flagBad.stderr).toContain('Unknown browser "netscape"');

      // …and a good flag overrides a bad env var (startup proceeds, so it is
      // killed by the timeout rather than exiting 1 on the selection).
      const flagGood = await runCli(['--browser', 'brave', '-v'], { COPILOT_BROWSER: 'netscape' });
      expect(flagGood.stderr).not.toContain('Unknown browser');
      expect(flagGood.stderr).toContain('Browser selection Brave ignored');
    });

    test('--browser-profile without --browser exits 1', async () => {
      const { exitCode, stderr } = await runCli(['--browser-profile', 'Default', '--live-reads']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('requires --browser');
    });

    test('COPILOT_BROWSER_PROFILE without a browser exits 1', async () => {
      const { exitCode, stderr } = await runCli(['--live-reads'], {
        COPILOT_BROWSER_PROFILE: 'Default',
      });

      expect(exitCode).toBe(1);
      expect(stderr).toContain('requires --browser');
    });

    test('--browser with no value exits 1', async () => {
      const { exitCode, stderr } = await runCli(['--browser']);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('--browser requires a value');
    });

    test('a selection without --live-reads/--write is reported as ignored in verbose mode', async () => {
      const { stderr } = await runCli([
        '--browser',
        'Microsoft-Edge',
        '--browser-profile',
        'Work',
        '-v',
      ]);

      expect(stderr).toContain('Browser selection Microsoft Edge (profile "Work") ignored');
    });
  });
});
