export const LIFEOS_HOME_SESSION_PREFIX = 'agent:jay:lifeos-home:';

export function optionalLifeOSHomeSessionKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const candidate = Array.isArray(value) ? value[0] : value;
  const sessionKey = typeof candidate === 'string' ? candidate.trim() : '';
  if (!sessionKey.startsWith(LIFEOS_HOME_SESSION_PREFIX) || sessionKey.length <= LIFEOS_HOME_SESSION_PREFIX.length) {
    throw new Error(`session_key must start with ${LIFEOS_HOME_SESSION_PREFIX} and include a conversation id`);
  }
  return sessionKey;
}
