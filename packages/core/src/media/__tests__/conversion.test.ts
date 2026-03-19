import { describe, it, expect } from 'vitest';
import { attachmentsToContentBlocks } from '../conversion.js';
import type { Attachment } from '../../types/agent.js';

describe('attachmentsToContentBlocks', () => {
  it('converts image attachment to image content block', () => {
    const att: Attachment = {
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from('fake-png-data'),
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from('fake-png-data').toString('base64'),
      },
    });
  });

  it('converts PDF attachment to document content block', () => {
    const att: Attachment = {
      type: 'file',
      mimeType: 'application/pdf',
      data: Buffer.from('fake-pdf-data'),
      filename: 'doc.pdf',
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from('fake-pdf-data').toString('base64'),
      },
    });
  });

  it('skips unsupported types', () => {
    const att: Attachment = {
      type: 'voice',
      mimeType: 'audio/ogg',
      data: Buffer.from('audio-data'),
    };
    const blocks = attachmentsToContentBlocks([att]);
    expect(blocks).toHaveLength(0);
  });

  it('handles multiple attachments', () => {
    const atts: Attachment[] = [
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpg') },
      { type: 'file', mimeType: 'application/pdf', data: Buffer.from('pdf') },
      { type: 'voice', mimeType: 'audio/ogg', data: Buffer.from('ogg') },
    ];
    const blocks = attachmentsToContentBlocks(atts);
    expect(blocks).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(attachmentsToContentBlocks([])).toEqual([]);
  });
});
