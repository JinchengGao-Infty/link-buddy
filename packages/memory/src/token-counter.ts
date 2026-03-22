export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Non-ASCII characters (Chinese, Japanese, etc.) are roughly 1 token each.
  // ASCII characters average ~4 chars per token.
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    tokens += text.charCodeAt(i) > 0x7F ? 1 : 0.25;
  }
  return Math.ceil(tokens);
}
