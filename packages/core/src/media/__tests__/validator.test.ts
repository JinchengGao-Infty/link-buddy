import { describe, it, expect } from 'vitest';
import { validateAttachment } from '../validator.js';
import type { Attachment } from '../../types/agent.js';
import type { MediaConfig } from '../../config/schema.js';

const config: MediaConfig = {
  max_file_size_mb: 10,
  allowed_mime_types: ['image/png', 'image/jpeg', 'application/pdf'],
};

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    type: 'image',
    mimeType: 'image/png',
    data: Buffer.alloc(1024),
    filename: 'test.png',
    ...overrides,
  };
}

describe('validateAttachment', () => {
  it('accepts valid attachment', () => {
    const result = validateAttachment(makeAttachment(), config);
    expect(result.valid).toBe(true);
  });

  it('rejects oversized attachment', () => {
    const big = makeAttachment({ data: Buffer.alloc(11 * 1024 * 1024) });
    const result = validateAttachment(big, config);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/size/i);
  });

  it('rejects disallowed mime type', () => {
    const svg = makeAttachment({ mimeType: 'image/svg+xml' });
    const result = validateAttachment(svg, config);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mime/i);
  });

  it('accepts PDF', () => {
    const pdf = makeAttachment({ type: 'file', mimeType: 'application/pdf', filename: 'doc.pdf' });
    const result = validateAttachment(pdf, config);
    expect(result.valid).toBe(true);
  });

  it('accepts attachment exactly at size limit', () => {
    const exact = makeAttachment({ data: Buffer.alloc(10 * 1024 * 1024) });
    const result = validateAttachment(exact, config);
    expect(result.valid).toBe(true);
  });
});
