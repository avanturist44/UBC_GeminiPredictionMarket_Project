import { describe, expect, it } from 'vitest';
import { allowWrite } from '../lib/rate-limit';
import { signSession, verifySession } from '../lib/session-token';
import { recordText } from '../lib/thesis-view';

const ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe('session cookie', () => {
  it('round-trips a user id under the same secret', () => {
    expect(verifySession(signSession(ID, 'secret-a'), 'secret-a')).toBe(ID);
  });

  it('rejects a value signed with another secret, altered, or malformed', () => {
    const value = signSession(ID, 'secret-a');
    expect(verifySession(value, 'secret-b')).toBeNull();
    expect(verifySession(value.replace('3f25', '4f25'), 'secret-a')).toBeNull();
    expect(verifySession(`${ID}.`, 'secret-a')).toBeNull();
    expect(verifySession(ID, 'secret-a')).toBeNull();
    expect(verifySession(undefined, 'secret-a')).toBeNull();
    expect(verifySession(signSession('not-a-uuid', 'secret-a'), 'secret-a')).toBeNull();
  });
});

describe('allowWrite', () => {
  it('allows ten writes a minute per session and refuses the eleventh', () => {
    const now = 1_000_000;
    const results = Array.from({ length: 11 }, (_, i) => allowWrite('user:a', now + i));
    expect(results.slice(0, 10).every(Boolean)).toBe(true);
    expect(results[10]).toBe(false);
    // Another session is unaffected, and the window slides.
    expect(allowWrite('user:b', now)).toBe(true);
    expect(allowWrite('user:a', now + 61_000)).toBe(true);
  });
});

describe('recordText', () => {
  it('states right over resolved with the Brier score', () => {
    expect(recordText({ resolved: 11, right: 7, brier: 0.1917, marketBrier: 0.22 })).toBe('7 of 11 right, Brier 0.19');
    expect(recordText({ resolved: 0, right: 0, brier: null, marketBrier: null })).toBe('No resolved theses yet');
  });
});
