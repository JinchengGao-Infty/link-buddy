import type { Attachment } from '../types/agent.js';

export interface ImageContentBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface DocumentContentBlock {
  type: 'document';
  source: { type: 'base64'; media_type: string; data: string };
}

export type AttachmentContentBlock = ImageContentBlock | DocumentContentBlock;

export function attachmentsToContentBlocks(attachments: Attachment[]): AttachmentContentBlock[] {
  const blocks: AttachmentContentBlock[] = [];

  for (const att of attachments) {
    if (att.mimeType.startsWith('image/')) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: att.mimeType,
          data: att.data.toString('base64'),
        },
      });
    } else if (att.mimeType === 'application/pdf') {
      blocks.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: att.data.toString('base64'),
        },
      });
    }
  }

  return blocks;
}
