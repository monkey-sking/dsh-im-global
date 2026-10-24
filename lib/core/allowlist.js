/**
 * Fail-closed allowlist for a chat bridge.
 *
 * A channel that can drive an agent must never be open by default. The rule
 * here is deliberately simple: no configured allowlist means nobody is let in.
 * The per-channel list wins when present; otherwise the plugin-level list is
 * used. The owner configures one of the two before anyone can talk to the bot.
 */

/**
 * Resolve the effective allowlist for a channel.
 * @param {{ allowedUsers?: Array<string|number> }} spec per-channel config
 * @param {{ allowedUsers?: Array<string|number> }} config plugin-level config
 * @returns {string[]} normalized user-id list (empty = deny everyone)
 */
export function resolveAllowedUsers(spec, config) {
  const perChannel = (spec?.allowedUsers ?? []).map(String).filter(Boolean);
  const list = perChannel.length > 0 ? perChannel : (config?.allowedUsers ?? []).map(String).filter(Boolean);
  return list;
}

/**
 * Decide whether a sender may drive the agent on this channel.
 * @param {{ allowedUsers?: Array<string|number> }} spec
 * @param {{ allowedUsers?: Array<string|number> }} config
 * @param {string|number} userId sender platform id
 * @returns {boolean} true only when the user is on an explicitly configured list
 */
export function isAllowed(spec, config, userId) {
  const list = resolveAllowedUsers(spec, config);
  if (list.length === 0) return false; // fail-closed
  return list.includes(String(userId));
}
