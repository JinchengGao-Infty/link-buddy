import type { User } from '../types/user.js';
import type { UserConfig } from '../config/schema.js';

/**
 * Manages platform-to-user identity mapping.
 *
 * UserConfig keys ending in `_id` (e.g. `discord_id`, `telegram_id`) are
 * treated as platform IDs. The platform name is derived by stripping the `_id`
 * suffix. An O(1) lookup index keyed on `"platform:platformId"` is built at
 * construction time.
 */
export class UserManager {
  private readonly users: User[];
  private readonly index: Map<string, User>;
  private readonly nameIndex: Map<string, User>;

  constructor(configs: UserConfig[]) {
    this.users = configs.map(UserManager.toUser);
    this.index = new Map();
    this.nameIndex = new Map();

    for (const user of this.users) {
      this.nameIndex.set(user.name.toLowerCase(), user);
      for (const [platform, platformId] of Object.entries(user.platformIds)) {
        this.index.set(`${platform}:${platformId}`, user);
      }
    }
  }

  /** Convert a UserConfig into a User by extracting `*_id` fields. */
  private static toUser(config: UserConfig): User {
    const platformIds: Record<string, string> = {};

    for (const [key, value] of Object.entries(config)) {
      if (key.endsWith('_id') && typeof value === 'string') {
        const platform = key.slice(0, -3); // strip trailing `_id`
        platformIds[platform] = value;
      }
    }

    return {
      name: config.name,
      role: config.role,
      platformIds,
    };
  }

  /** Look up a user by platform name and platform-specific user ID. */
  findByPlatformId(platform: string, platformId: string): User | undefined {
    return this.index.get(`${platform}:${platformId}`);
  }

  /** Look up a user by display name (case-insensitive). */
  findByName(name: string): User | undefined {
    return this.nameIndex.get(name.toLowerCase());
  }

  /**
   * Build a deterministic session ID from user name, platform, and channel.
   * Format: `<userName>-<platform>-<channelId>` (all lowercased).
   */
  buildSessionId(userName: string, platform: string, channelId: string): string {
    return `${userName.toLowerCase()}-${platform.toLowerCase()}-${channelId.toLowerCase()}`;
  }

  /** Return an immutable snapshot of all managed users. */
  getAllUsers(): ReadonlyArray<User> {
    return this.users;
  }
}
