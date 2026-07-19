import { describe, expect, it } from 'vitest';
import { nodeCommandRunner } from './runner.js';

describe('nodeCommandRunner', () => {
  it('captures stdout, stderr, and the exit code of a completed run', async () => {
    const result = await nodeCommandRunner.run(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err"); process.exit(3)'],
      5_000,
    );
    expect(result).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('kills a run that exceeds its timeout and flags it', async () => {
    const result = await nodeCommandRunner.run(
      process.execPath,
      ['-e', 'setTimeout(() => undefined, 60_000)'],
      100,
    );
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it('rejects when the binary cannot be spawned at all', async () => {
    await expect(
      nodeCommandRunner.run('/nonexistent/interpreter', [], 1_000),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
