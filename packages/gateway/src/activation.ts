import type { IncomingMessage, PlatformConfig } from '@ccbuddy/core';

export function shouldRespond(msg: IncomingMessage, platformsConfig: PlatformConfig): boolean {
  if (msg.channelType === 'dm') return true;

  const platformConfig = platformsConfig[msg.platform];
  if (!platformConfig?.channels) return msg.isMention;

  const channelConfig = platformConfig.channels[msg.channelId];
  if (!channelConfig) return msg.isMention;

  return channelConfig.mode === 'all' || msg.isMention;
}
