import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAllowedUsers, isAllowed } from '../lib/core/allowlist.js';

test('isAllowed is fail-closed: an empty list denies everyone', () => {
  assert.equal(isAllowed({ allowedUsers: [] }, { allowedUsers: [] }, 'anything'), false);
  assert.equal(isAllowed({ allowedUsers: undefined }, { allowedUsers: undefined }, 'anything'), false);
  assert.equal(isAllowed({}, {}, ''), false);
});

test('per-channel list wins over the plugin-level list', () => {
  const spec = { allowedUsers: ['alice'] };
  const config = { allowedUsers: ['bob'] };
  assert.equal(resolveAllowedUsers(spec, config)[0], 'alice');
  assert.equal(isAllowed(spec, config, 'alice'), true);
  assert.equal(isAllowed(spec, config, 'bob'), false);
});

test('an empty per-channel list falls back to the plugin-level list', () => {
  const spec = { allowedUsers: [] };
  const config = { allowedUsers: ['bob', 'carol'] };
  assert.deepEqual(resolveAllowedUsers(spec, config), ['bob', 'carol']);
  assert.equal(isAllowed(spec, config, 'bob'), true);
  assert.equal(isAllowed(spec, config, 'alice'), false);
});

test('user ids are compared as strings', () => {
  const config = { allowedUsers: ['42'] };
  assert.equal(isAllowed({}, config, 42), true); // numeric sender id matches string entry
  assert.equal(isAllowed({}, config, '42'), true);
  assert.equal(isAllowed({}, config, 43), false);
});