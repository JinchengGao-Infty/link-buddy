import type { Attachment } from '../types/agent.js';
import type { MediaConfig } from '../config/schema.js';

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateAttachment(
  attachment: Attachment,
  config: MediaConfig,
): ValidationResult {
  const maxBytes = config.max_file_size_mb * 1024 * 1024;
  if (attachment.data.byteLength > maxBytes) {
    return {
      valid: false,
      reason: `File size ${Math.round(attachment.data.byteLength / 1024)}KB exceeds limit of ${config.max_file_size_mb}MB`,
    };
  }

  if (!config.allowed_mime_types.includes(attachment.mimeType)) {
    return {
      valid: false,
      reason: `MIME type "${attachment.mimeType}" is not allowed`,
    };
  }

  return { valid: true };
}
