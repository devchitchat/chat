/**
 * buildDmChannelName — deterministic canonical key for a DM channel.
 *
 * Sorting the two user IDs alphabetically ensures the same name regardless
 * of who initiates: dm:u_abc:u_xyz == dm:u_xyz:u_abc.
 */
export function buildDmChannelName(userIdA, userIdB) {
  const [a, b] = [userIdA, userIdB].sort()
  return `dm:${a}:${b}`
}
