import path from 'node:path';

export const AUTH_DIR = path.join(__dirname, '..', '.data', 'auth');
export const OWNER_STATE = path.join(AUTH_DIR, 'owner.json');
export const BOB_STATE = path.join(AUTH_DIR, 'bob.json');
export const DANA_STATE = path.join(AUTH_DIR, 'dana.json');

export const WORKSPACE = 'Relay E2E';

export interface TestUser {
  fullName: string;
  email: string;
  password: string;
  /** derived by the server from the email local part */
  username: string;
  state: string;
}

/** Workspace owner, created through the /setup form. */
export const OWNER: TestUser = {
  fullName: 'Alice Owner',
  email: 'alice@example.com',
  password: 'alice-secret-123',
  username: 'alice',
  state: OWNER_STATE,
};

/** Regular member, created via invite API in global setup. */
export const BOB: TestUser = {
  fullName: 'Bob Member',
  email: 'bob@example.com',
  password: 'bob-secret-123',
  username: 'bob',
  state: BOB_STATE,
};

/** Member used by tests that change personal preferences (theme, language). */
export const DANA: TestUser = {
  fullName: 'Dana Prefs',
  email: 'dana@example.com',
  password: 'dana-secret-123',
  username: 'dana',
  state: DANA_STATE,
};
