import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { JxaBridge } from '../jxa-bridge.js';

describe('JxaBridge', () => {
  let bridge: JxaBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new JxaBridge();
  });

  it('calls execFile with osascript and JavaScript flag', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: true }), '');
    });

    await bridge.exec('(() => { return JSON.stringify({ success: true }); })()');

    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      ['-l', 'JavaScript', '-e', '(() => { return JSON.stringify({ success: true }); })()'],
      expect.objectContaining({ timeout: 10000 }),
      expect.any(Function),
    );
  });

  it('parses JSON stdout on success', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: true, notes: [] }), '');
    });

    const result = await bridge.exec('some script');
    expect(result.success).toBe(true);
    expect((result as any).notes).toEqual([]);
  });

  it('trims whitespace before parsing stdout', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, `  ${JSON.stringify({ success: true, value: 42 })}  \n`, '');
    });

    const result = await bridge.exec('some script');
    expect(result.success).toBe(true);
    expect((result as any).value).toBe(42);
  });

  it('throws on non-JSON stdout', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, 'not json', '');
    });

    await expect(bridge.exec('some script')).rejects.toThrow('Failed to parse JXA output');
  });

  it('throws on execFile error', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('osascript: execution error'), '', '');
    });

    await expect(bridge.exec('some script')).rejects.toThrow('osascript: execution error');
  });

  it('respects custom timeout', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, JSON.stringify({ success: true }), '');
    });

    const customBridge = new JxaBridge(5000);
    await customBridge.exec('script');

    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });
});
