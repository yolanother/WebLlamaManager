// Llama Manager — shared conversation list store.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// External store (React `useSyncExternalStore`) that owns the persisted chat
// conversation list and the active conversation id, so both the chat page and
// the chat-first shell's sidebar can read and mutate the same state under the
// same localStorage keys (`chat_conversations`, `chat_active_conversation`)
// the Chat page previously kept in local `useState`. Guarantees at least one
// conversation always exists, keeps the active id valid, and reports
// persistence (localStorage) failures through `subscribeErrors` rather than
// throwing.

import { useSyncExternalStore } from 'react';

/** localStorage key under which the conversation list is persisted. */
export const CONVERSATIONS_KEY = 'chat_conversations';

/** localStorage key under which the active conversation id is persisted. */
export const ACTIVE_CONVERSATION_KEY = 'chat_active_conversation';

/**
 * Generate a client-side unique id, preferring the platform UUID generator.
 * @returns {string} A new unique id.
 */
function makeId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Build a fresh empty conversation.
 * @returns {object} A new conversation record.
 */
export function makeConversation() {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: 'New conversation',
    model: 'auto',
    messages: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Normalize a persisted or otherwise untrusted value into a conversation
 * array, filling in any missing required fields. Non-array input yields an
 * empty list.
 * @param {unknown} raw - Candidate conversation list (e.g. `JSON.parse` output).
 * @returns {object[]} A normalized conversation array.
 */
export function normalizeConversations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((conversation) => ({
    ...conversation,
    id: conversation.id || makeId(),
    title: conversation.title || 'New conversation',
    model: conversation.model || 'auto',
    messages: Array.isArray(conversation.messages) ? conversation.messages : [],
    artifacts: Array.isArray(conversation.artifacts) ? conversation.artifacts : [],
  }));
}

/**
 * Classify a timestamp into the date-grouped conversation list's bucket.
 * @param {string|number|Date} timestamp - Conversation `updatedAt`/`createdAt`.
 * @param {Date} [now] - Reference "now" (injectable for tests).
 * @returns {'Today'|'Yesterday'|'Previous 7 days'|'Older'} The bucket label.
 */
export function dateGroup(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startToday - startDate) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'Previous 7 days';
  return 'Older';
}

/** Internal mutable state; never exposed directly (see {@link getSnapshot}). */
const state = { conversations: [], activeId: null };

/** Immutable snapshot handed to `useConversations` subscribers. */
let snapshot = { conversations: [], activeId: null, active: undefined };

/** Set of store subscribers. */
const listeners = new Set();

/** Set of persistence-error subscribers. */
const errorListeners = new Set();

/**
 * Rebuild the public snapshot from internal state and notify subscribers.
 */
function emit() {
  snapshot = {
    conversations: state.conversations,
    activeId: state.activeId,
    active: state.conversations.find((conversation) => conversation.id === state.activeId),
  };
  for (const listener of listeners) listener();
}

/**
 * Report a localStorage persistence failure to error subscribers.
 * @param {string} message - Human-readable error message.
 */
function notifyError(message) {
  for (const listener of errorListeners) listener(message);
}

/** Persist the current conversation list, reporting failures. */
function persistConversations() {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(state.conversations));
  } catch (error) {
    notifyError(`Could not save conversations locally: ${error.message}`);
  }
}

/** Persist the current active conversation id, reporting failures. */
function persistActiveId() {
  if (!state.activeId) return;
  try {
    localStorage.setItem(ACTIVE_CONVERSATION_KEY, state.activeId);
  } catch (error) {
    notifyError(`Could not save the active conversation locally: ${error.message}`);
  }
}

/**
 * Subscribe to store changes.
 * @param {() => void} callback - Invoked on every state change.
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * @returns {{conversations: object[], activeId: string|null, active: object|undefined}}
 *   The current immutable store snapshot (stable reference between mutations).
 *   Exported for imperative reads outside React (tests, non-component code);
 *   `useConversations()` is the React-facing way to read the store.
 */
export function getSnapshot() {
  return snapshot;
}

/**
 * Subscribe to persistence (localStorage) failures.
 * @param {(message: string) => void} callback - Invoked with a human-readable
 *   error message whenever a write to localStorage fails.
 * @returns {() => void} Unsubscribe function.
 */
export function subscribeErrors(callback) {
  errorListeners.add(callback);
  return () => errorListeners.delete(callback);
}

/**
 * React hook exposing the live conversation list, active id, and resolved
 * active conversation.
 * @returns {{conversations: object[], activeId: string|null, active: object|undefined}}
 */
export function useConversations() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Create a new empty conversation, prepend it, and select it.
 * @returns {object} The created conversation.
 */
export function createConversation() {
  const conversation = makeConversation();
  state.conversations = [conversation, ...state.conversations];
  state.activeId = conversation.id;
  persistConversations();
  persistActiveId();
  emit();
  return conversation;
}

/**
 * Delete a conversation. If it was active, the next remaining conversation
 * (if any) becomes active. Deleting the last conversation creates and
 * selects a fresh empty one, so the store always holds at least one.
 * @param {string} id - Conversation id to delete.
 */
export function deleteConversation(id) {
  let remaining = state.conversations.filter((conversation) => conversation.id !== id);
  let nextActiveId = state.activeId;
  if (remaining.length === 0) {
    const conversation = makeConversation();
    remaining = [conversation];
    nextActiveId = conversation.id;
  } else if (id === state.activeId) {
    nextActiveId = remaining[0]?.id || null;
  }
  state.conversations = remaining;
  state.activeId = nextActiveId;
  persistConversations();
  persistActiveId();
  emit();
}

/**
 * Apply an update to one conversation, stamping `updatedAt`.
 * @param {string} id - Conversation id to update.
 * @param {object|((conversation: object) => object)} updates - A partial
 *   object to merge, or a function of the current conversation returning one.
 */
export function updateConversation(id, updates) {
  state.conversations = state.conversations.map((conversation) => (
    conversation.id === id
      ? {
        ...conversation,
        ...(typeof updates === 'function' ? updates(conversation) : updates),
        updatedAt: new Date().toISOString(),
      }
      : conversation
  ));
  persistConversations();
  emit();
}

/**
 * Rename a conversation.
 * @param {string} id - Conversation id to rename.
 * @param {string} title - New title.
 */
export function renameConversation(id, title) {
  updateConversation(id, { title });
}

/**
 * Select a conversation as active.
 * @param {string} id - Conversation id to select.
 */
export function selectConversation(id) {
  state.activeId = id;
  persistActiveId();
  emit();
}

/**
 * Merge an imported conversation list (or `{ conversations: [...] }`
 * envelope) into the store, prepending the imports and selecting the first
 * imported conversation.
 * @param {unknown} list - Parsed JSON: a conversation array, or an object
 *   carrying one under `conversations`.
 * @returns {object[]} The normalized, imported conversations.
 * @throws {Error} If `list` does not resolve to an array.
 */
export function importConversations(list) {
  const imported = Array.isArray(list) ? list : list?.conversations;
  if (!Array.isArray(imported)) throw new Error('Expected a JSON conversation array.');
  const now = new Date().toISOString();
  const normalized = imported.map((conversation) => ({
    ...conversation,
    id: conversation.id || makeId(),
    title: conversation.title || 'Imported conversation',
    model: conversation.model || 'auto',
    messages: Array.isArray(conversation.messages) ? conversation.messages : [],
    artifacts: Array.isArray(conversation.artifacts) ? conversation.artifacts : [],
    createdAt: conversation.createdAt || now,
    updatedAt: conversation.updatedAt || now,
  }));
  state.conversations = [...normalized, ...state.conversations];
  if (normalized[0]) state.activeId = normalized[0].id;
  persistConversations();
  persistActiveId();
  emit();
  return normalized;
}

/**
 * Load persisted conversations from localStorage, tolerating missing or
 * corrupt data.
 * @returns {object[]} Normalized conversations (possibly empty).
 */
function readStoredConversations() {
  try {
    return normalizeConversations(JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) || '[]'));
  } catch {
    return [];
  }
}

/**
 * Load the persisted active conversation id from localStorage, tolerating a
 * missing/unavailable store.
 * @returns {string|null} The persisted id, or `null`.
 */
function readStoredActiveId() {
  try {
    return localStorage.getItem(ACTIVE_CONVERSATION_KEY);
  } catch {
    return null;
  }
}

/**
 * Load initial state from localStorage, guaranteeing at least one
 * conversation exists and the active id points at a real conversation.
 */
function initState() {
  const conversations = readStoredConversations();
  let activeId = readStoredActiveId();
  let createdDefault = false;
  if (conversations.length === 0) {
    conversations.push(makeConversation());
    activeId = conversations[0].id;
    createdDefault = true;
  } else if (!conversations.some((conversation) => conversation.id === activeId)) {
    activeId = conversations[0].id;
  }
  state.conversations = conversations;
  state.activeId = activeId;
  if (createdDefault) persistConversations();
  persistActiveId();
  emit();
}

initState();
