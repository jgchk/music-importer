import { spawn } from 'node:child_process';

/**
 * A minimal process-runner seam for the beets bridge adapter. It resolves with the child's exit
 * code and captured output for any completed run (a non-zero exit is how the bridge signals an
 * unexpected crash), flags a run that had to be killed on timeout, and rejects only when the
 * process cannot be spawned at all (e.g. the interpreter is missing) — which the adapter maps to
 * an `InfraError`.
 */
export interface CommandResult {
  readonly code: number | null; // null when the process was terminated by a signal
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
}

export const nodeCommandRunner: CommandRunner = {
  run(command, args, timeoutMs) {
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args]);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
  },
};
