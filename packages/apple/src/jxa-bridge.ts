import { execFile } from 'node:child_process';

export class JxaBridge {
  private readonly timeoutMs: number;

  constructor(timeoutMs = 10000) {
    this.timeoutMs = timeoutMs;
  }

  exec(script: string): Promise<{ success: boolean; [key: string]: unknown }> {
    return new Promise((resolve, reject) => {
      execFile(
        'osascript',
        ['-l', 'JavaScript', '-e', script],
        { timeout: this.timeoutMs },
        (err, stdout, _stderr) => {
          if (err) {
            reject(err);
            return;
          }

          try {
            const result = JSON.parse(stdout.trim());
            resolve(result);
          } catch {
            reject(new Error(`Failed to parse JXA output: ${stdout.slice(0, 200)}`));
          }
        },
      );
    });
  }
}
