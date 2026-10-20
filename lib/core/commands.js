/**
 * In-chat command parsing.
 *
 * Kept free of plugin/host imports so it can be unit-tested outside the harness.
 * Both prefixes are accepted: `!new` is the one that works in Discord (a leading
 * `/` there is reserved for registered slash commands), `/new` reads naturally
 * in Slack and Matrix.
 */

const KNOWN = new Set(['new', 'start', 'status', 'help', 'clear']);

/** Parse `/name rest` or `!name rest`; unknown verbs fall through to the agent. */
export function parseCommand(text) {
  const match = /^[/!]([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!match) return undefined;
  const verb = match[1].toLowerCase();
  return KNOWN.has(verb) ? { verb, rest: (match[2] ?? '').trim() } : undefined;
}
