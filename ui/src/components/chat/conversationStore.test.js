// Llama Manager — conversation store unit tests.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Covers the store's DOM-free logic (normalization, `dateGroup`) directly,
// and its persisted actions (create/delete/update/import) against a stubbed
// `globalThis.localStorage`, re-importing the module fresh per scenario so
// each test observes its own initial persisted state.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATIONS_KEY,
  ACTIVE_CONVERSATION_KEY,
  dateGroup,
  makeConversation,
  normalizeConversations,
} from './conversationStore.js';

/** A minimal synchronous localStorage stand-in for `node --test`. */
function makeLocalStorageStub() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * Install a fresh localStorage stub (optionally pre-seeded) and re-import
 * the store module under a cache-busting query so its top-level init logic
 * runs again against the new stub.
 */
async function freshStore({ conversations, activeId } = {}) {
  const localStorage = makeLocalStorageStub();
  if (conversations !== undefined) {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  }
  if (activeId !== undefined) {
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, activeId);
  }
  globalThis.localStorage = localStorage;
  const store = await import(`./conversationStore.js?t=${Date.now()}-${Math.random()}`);
  return { store, localStorage };
}

test('exports the persisted storage key contract unchanged', () => {
  assert.equal(CONVERSATIONS_KEY, 'chat_conversations');
  assert.equal(ACTIVE_CONVERSATION_KEY, 'chat_active_conversation');
});

test('normalizeConversations drops junk and fills required fields', () => {
  assert.deepEqual(normalizeConversations(null), []);
  assert.deepEqual(normalizeConversations('nope'), []);
  const [conversation] = normalizeConversations([{ id: 'a' }]);
  assert.equal(conversation.id, 'a');
  assert.equal(conversation.title, 'New conversation');
  assert.equal(conversation.model, 'auto');
  assert.deepEqual(conversation.messages, []);
  assert.deepEqual(conversation.artifacts, []);
});

test('normalizeConversations preserves populated fields and assigns a missing id', () => {
  const [conversation] = normalizeConversations([{
    title: 'Kept', model: 'llama', messages: [{ role: 'user' }], artifacts: [{ id: 'x' }],
  }]);
  assert.ok(conversation.id);
  assert.equal(conversation.title, 'Kept');
  assert.equal(conversation.model, 'llama');
  assert.deepEqual(conversation.messages, [{ role: 'user' }]);
  assert.deepEqual(conversation.artifacts, [{ id: 'x' }]);
});

test('makeConversation produces a fresh empty conversation', () => {
  const a = makeConversation();
  const b = makeConversation();
  assert.notEqual(a.id, b.id);
  assert.equal(a.title, 'New conversation');
  assert.equal(a.model, 'auto');
  assert.deepEqual(a.messages, []);
  assert.deepEqual(a.artifacts, []);
  assert.equal(a.createdAt, a.updatedAt);
});

test('dateGroup buckets today, yesterday, previous 7 days, and older', () => {
  // Built from local Date components (not UTC ISO strings) so the boundary
  // math is independent of the test runner's timezone.
  const now = new Date(2026, 8, 15, 12, 0, 0);
  assert.equal(dateGroup(new Date(2026, 8, 15, 1, 0, 0), now), 'Today');
  assert.equal(dateGroup(new Date(2026, 8, 14, 23, 0, 0), now), 'Yesterday');
  assert.equal(dateGroup(new Date(2026, 8, 10, 0, 0, 0), now), 'Previous 7 days');
  assert.equal(dateGroup(new Date(2026, 8, 1, 0, 0, 0), now), 'Older');
});

test('a fresh store with no persisted data creates and selects one conversation', async () => {
  const { store, localStorage } = await freshStore();
  const snapshot1 = store.getSnapshot();
  assert.equal(snapshot1.conversations.length, 1);
  assert.equal(snapshot1.activeId, snapshot1.conversations[0].id);
  assert.equal(snapshot1.active.id, snapshot1.activeId);
  assert.equal(JSON.parse(localStorage.getItem(CONVERSATIONS_KEY)).length, 1);
  assert.equal(localStorage.getItem(ACTIVE_CONVERSATION_KEY), snapshot1.activeId);
});

test('a store with a stale active id falls back to the first conversation', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    activeId: 'missing',
  });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeId, 'a');
});

test('createConversation prepends and selects the new conversation', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }],
    activeId: 'a',
  });
  const created = store.createConversation();
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations[0].id, created.id);
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(snapshot.activeId, created.id);
});

test('deleteConversation of the active one selects the next remaining conversation', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    activeId: 'a',
  });
  store.deleteConversation('a');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.activeId, 'b');
});

test('deleting the last conversation creates and selects a fresh one', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }],
    activeId: 'a',
  });
  store.deleteConversation('a');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations.length, 1);
  assert.notEqual(snapshot.conversations[0].id, 'a');
  assert.equal(snapshot.activeId, snapshot.conversations[0].id);
});

test('deleting an inactive conversation leaves the active id untouched', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    activeId: 'a',
  });
  store.deleteConversation('b');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeId, 'a');
  assert.equal(snapshot.conversations.length, 1);
});

test('updateConversation with an object merges fields and stamps updatedAt', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A', updatedAt: '2020-01-01T00:00:00.000Z' }],
    activeId: 'a',
  });
  store.updateConversation('a', { title: 'Renamed' });
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations[0].title, 'Renamed');
  assert.notEqual(snapshot.conversations[0].updatedAt, '2020-01-01T00:00:00.000Z');
});

test('updateConversation with an updater function merges its return value and stamps updatedAt', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A', messages: [] }],
    activeId: 'a',
  });
  store.updateConversation('a', (conversation) => ({ messages: [...conversation.messages, 'hi'] }));
  const snapshot = store.getSnapshot();
  assert.deepEqual(snapshot.conversations[0].messages, ['hi']);
  assert.ok(snapshot.conversations[0].updatedAt);
});

test('renameConversation is a thin wrapper over updateConversation', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }],
    activeId: 'a',
  });
  store.renameConversation('a', 'New title');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.conversations[0].title, 'New title');
});

test('selectConversation switches the active id and persists it', async () => {
  const { store, localStorage } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    activeId: 'a',
  });
  store.selectConversation('b');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.activeId, 'b');
  assert.equal(localStorage.getItem(ACTIVE_CONVERSATION_KEY), 'b');
});

test('importConversations merges a plain array, prepending and selecting the first import', async () => {
  const { store } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }],
    activeId: 'a',
  });
  const imported = store.importConversations([{ id: 'x', title: 'Imported one' }]);
  const snapshot = store.getSnapshot();
  assert.equal(imported[0].id, 'x');
  assert.equal(imported[0].title, 'Imported one');
  assert.equal(snapshot.conversations.length, 2);
  assert.equal(snapshot.conversations[0].id, 'x');
  assert.equal(snapshot.activeId, 'x');
});

test('importConversations accepts a { conversations } envelope', async () => {
  const { store } = await freshStore({ conversations: [{ id: 'a', title: 'A' }], activeId: 'a' });
  const imported = store.importConversations({ conversations: [{ id: 'y' }] });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].id, 'y');
});

test('importConversations rejects a non-array payload', async () => {
  const { store } = await freshStore({ conversations: [{ id: 'a', title: 'A' }], activeId: 'a' });
  assert.throws(() => store.importConversations({ nope: true }), /Expected a JSON conversation array/);
});

test('subscribeErrors reports a localStorage write failure', async () => {
  const { store, localStorage } = await freshStore({
    conversations: [{ id: 'a', title: 'A' }],
    activeId: 'a',
  });
  localStorage.setItem = () => { throw new Error('quota exceeded'); };
  const messages = [];
  const unsubscribe = store.subscribeErrors((message) => messages.push(message));
  store.createConversation();
  unsubscribe();
  assert.ok(messages.some((message) => message.includes('quota exceeded')));
});
