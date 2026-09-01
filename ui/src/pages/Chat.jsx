// Llama Manager — first-class multimodal chat page.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Composes multimodal media ingest, rich messages, automatic model routing,
// and cancellable streaming completions around the conversation list owned
// by `conversationStore.js` (list/active-id state and its localStorage
// persistence live there now, shared with the chat-first shell's sidebar).
// The `embedded` prop drops the page's own conversation rail, hamburger, and
// new-conversation button when the chat-first shell already provides them.

import { useCallback, useEffect, useMemo, useState } from 'react';

import { API_BASE } from '../api.js';
import { ArtifactWorkbench } from '../components/chat/ArtifactWorkbench.jsx';
import { Composer } from '../components/chat/Composer.jsx';
import { ConversationSidebar } from '../components/chat/ConversationSidebar.jsx';
import {
  createConversation as createStoredConversation,
  deleteConversation,
  importConversations as importConversationsIntoStore,
  renameConversation,
  selectConversation,
  subscribeErrors,
  updateConversation,
  useConversations,
} from '../components/chat/conversationStore.js';
import { MessageList } from '../components/chat/MessageList.jsx';
import { contentToText } from '../components/chat/Message.jsx';
import {
  buildMessageContent,
  buildReadyMediaAttachment,
  classifyUrl,
  partitionMediaFiles,
} from '../components/chat/attachments.js';
import {
  assembleArtifactEditMessages,
  createArtifact,
  extractArtifacts,
  moveArtifactVersion,
  parseArtifactEditResponse,
  pushArtifactVersion,
} from '../components/chat/artifacts.js';
import { useChatStream } from '../components/chat/useChatStream.js';
import '../styles/chat.css';

/** Generate a client-side unique id for messages, attachments, and artifacts. */
function makeId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function responseToDataUrl(url) {
  if (url.startsWith('data:')) return url;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch media asset (HTTP ${response.status}).`);
  return fileToDataUrl(await response.blob());
}

async function readMediaError(response) {
  try {
    const data = await response.json();
    return {
      error: data.error || `HTTP ${response.status}`,
      hint: data.hint || '',
    };
  } catch {
    return { error: `HTTP ${response.status}`, hint: '' };
  }
}

/**
 * First-class chat composition root.
 *
 * @param {object} props
 * @param {object} [props.stats] - The websocket `stats` payload.
 * @param {boolean} [props.embedded] - When true, renders inside the
 *   chat-first shell: no conversation rail, hamburger, or new-conversation
 *   icon button (the shell provides all three), and a centred message column.
 */
function ChatPage({ stats, embedded = false }) {
  const { conversations, activeId: activeConversationId, active: activeConversation } = useConversations();
  const [models, setModels] = useState([]);
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= 1200);
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [editing, setEditing] = useState(null);
  const [activeArtifactId, setActiveArtifactId] = useState(null);
  const [artifactContextEnabled, setArtifactContextEnabled] = useState(false);
  const [pageError, setPageError] = useState('');
  const [pageNotice, setPageNotice] = useState('');
  const [streamConversationId, setStreamConversationId] = useState(null);
  const {
    isStreaming,
    routedModel,
    stop,
    streamChat,
    streamingMessage,
  } = useChatStream();

  const activeArtifact = useMemo(
    () => activeConversation?.artifacts?.find((artifact) => artifact.id === activeArtifactId),
    [activeArtifactId, activeConversation],
  );
  const healthy = !stats
    || stats.llama?.status === 'ok'
    || stats.ds4?.status === 'ok';

  useEffect(() => subscribeErrors(setPageError), []);

  useEffect(() => {
    if (activeArtifactId && activeConversation && !activeArtifact) {
      setActiveArtifactId(null);
      setArtifactContextEnabled(false);
    }
  }, [activeArtifact, activeArtifactId, activeConversation]);

  useEffect(() => {
    if (!pageNotice) return undefined;
    const timeout = setTimeout(() => setPageNotice(''), 3600);
    return () => clearTimeout(timeout);
  }, [pageNotice]);

  const fetchModels = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/models`);
      if (!response.ok) return;
      const data = await response.json();
      setModels(data.data || []);
    } catch {
      // The global connection state already communicates server availability.
    }
  }, []);

  useEffect(() => {
    fetchModels();
    const interval = setInterval(fetchModels, 10000);
    return () => clearInterval(interval);
  }, [fetchModels]);

  const replaceAttachment = useCallback((id, replacement) => {
    setAttachments((current) => current.map((attachment) => (
      attachment.id === id
        ? { ...attachment, ...replacement }
        : attachment
    )));
  }, []);

  const addImages = useCallback((files) => {
    files.forEach(async (file) => {
      const id = makeId();
      setAttachments((current) => [...current, {
        id,
        kind: 'image',
        filename: file.name,
        status: 'uploading',
        source: { type: 'image', file },
      }]);
      try {
        replaceAttachment(id, {
          dataUrl: await fileToDataUrl(file),
          status: 'ready',
          error: '',
          hint: '',
        });
      } catch (error) {
        replaceAttachment(id, { status: 'error', error: error.message, hint: '' });
      }
    });
  }, [replaceAttachment]);

  const ingestMedia = useCallback(async (id, source) => {
    replaceAttachment(id, {
      status: 'uploading',
      error: '',
      hint: '',
    });
    try {
      let endpoint;
      let options;
      if (source.type === 'audio-file' || source.type === 'video-file') {
        endpoint = `${API_BASE}/media/upload`;
        const form = new FormData();
        form.append('file', source.file);
        options = { method: 'POST', body: form };
      } else {
        const kind = classifyUrl(source.url);
        endpoint = kind === 'youtube'
          ? `${API_BASE}/media/youtube`
          : `${API_BASE}/media/link`;
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: source.url }),
        };
      }

      const response = await fetch(endpoint, options);
      if (!response.ok) {
        const detail = await readMediaError(response);
        replaceAttachment(id, { status: 'error', ...detail });
        return;
      }
      const media = await response.json();
      const frames = await Promise.all((media.frames || []).map(async (url) => ({
        dataUrl: await responseToDataUrl(url),
      })));
      const segmentDataUrls = await Promise.all(
        (media.audio?.segments || []).map(responseToDataUrl),
      );
      replaceAttachment(id, buildReadyMediaAttachment({
        media,
        source,
        frames,
        segmentDataUrls,
      }));
    } catch (error) {
      replaceAttachment(id, {
        status: 'error',
        error: error.message || 'Media ingest failed.',
        hint: '',
      });
    }
  }, [replaceAttachment]);

  const addAudioFiles = useCallback((files) => {
    files.forEach((file) => {
      const id = makeId();
      const source = { type: 'audio-file', file };
      setAttachments((current) => [...current, {
        id,
        kind: 'audio',
        filename: file.name,
        status: 'uploading',
        source,
      }]);
      ingestMedia(id, source);
    });
  }, [ingestMedia]);

  const addVideoFiles = useCallback((files) => {
    files.forEach((file) => {
      const id = makeId();
      const source = { type: 'video-file', file };
      setAttachments((current) => [...current, {
        id,
        kind: 'video',
        filename: file.name,
        status: 'uploading',
        source,
      }]);
      ingestMedia(id, source);
    });
  }, [ingestMedia]);

  const addVideoUrl = useCallback((url) => {
    const id = makeId();
    const source = { type: 'video-url', url };
    setAttachments((current) => [...current, {
      id,
      kind: 'video',
      filename: url,
      status: 'uploading',
      source,
    }]);
    ingestMedia(id, source);
  }, [ingestMedia]);

  const retryAttachment = useCallback((id) => {
    const attachment = attachments.find((item) => item.id === id);
    if (!attachment?.source) return;
    if (attachment.source.type === 'image') {
      replaceAttachment(id, { status: 'uploading', error: '', hint: '' });
      fileToDataUrl(attachment.source.file)
        .then((dataUrl) => replaceAttachment(id, { status: 'ready', dataUrl }))
        .catch((error) => replaceAttachment(id, {
          status: 'error',
          error: error.message,
          hint: '',
        }));
    } else {
      ingestMedia(id, attachment.source);
    }
  }, [attachments, ingestMedia, replaceAttachment]);

  const addLongText = useCallback((text) => {
    setAttachments((current) => [...current, {
      id: makeId(),
      kind: 'text',
      filename: 'pasted-text.txt',
      text,
      status: 'ready',
      source: { type: 'text' },
    }]);
  }, []);

  const serializableAttachments = (items) => items
    .filter((attachment) => attachment.status === 'ready')
    .map(({ source, status, ...attachment }) => attachment);

  const runAssistant = useCallback(async (
    conversationId,
    baseMessages,
    model,
    artifactEdit = null,
  ) => {
    setStreamConversationId(conversationId);
    try {
      const requestMessages = baseMessages.map((message) => ({
        role: message.role,
        content: message.requestContent ?? message.content,
      }));
      const result = await streamChat({
        model: model || 'auto',
        messages: artifactEdit
          ? assembleArtifactEditMessages(requestMessages, artifactEdit)
          : requestMessages,
      });
      const timestamp = new Date().toISOString();
      const assistantBase = {
        id: makeId(),
        role: 'assistant',
        requestContent: result.content,
        ...(artifactEdit ? { artifactEditId: artifactEdit.id } : {}),
        routedModel: result.routedModel,
        stopped: result.stopped,
        timestamp,
        stats: result.stats,
      };

      if (artifactEdit) {
        const parsed = parseArtifactEditResponse(result.content);
        if (parsed) {
          const assistant = {
            ...assistantBase,
            content: parsed.summary || `Updated ${artifactEdit.title}.`,
            artifactIds: [artifactEdit.id],
            artifactUpdate: true,
          };
          updateConversation(conversationId, (conversation) => ({
            messages: [...baseMessages, assistant],
            artifacts: (conversation.artifacts || []).map((artifact) => {
              if (artifact.id !== artifactEdit.id) return artifact;
              return {
                ...pushArtifactVersion(artifact, parsed.content, {
                  source: 'agent',
                  createdAt: timestamp,
                }),
                language: parsed.language || artifact.language,
              };
            }),
          }));
        } else {
          setPageNotice('No file update detected.');
          updateConversation(conversationId, {
            messages: [...baseMessages, {
              ...assistantBase,
              content: result.content,
            }],
          });
        }
      } else {
        const extracted = extractArtifacts(result.content);
        const newArtifacts = extracted.artifacts.map((candidate) => createArtifact({
          ...candidate,
          id: makeId(),
        }, { createdAt: timestamp }));
        const assistant = {
          ...assistantBase,
          content: extracted.displayContent,
          ...(newArtifacts.length ? { artifactIds: newArtifacts.map((artifact) => artifact.id) } : {}),
        };
        updateConversation(conversationId, (conversation) => ({
          messages: [...baseMessages, assistant],
          artifacts: [...(conversation.artifacts || []), ...newArtifacts],
        }));
      }
    } catch (error) {
      updateConversation(conversationId, {
        messages: [...baseMessages, {
          id: makeId(),
          role: 'assistant',
          content: `Error: ${error.message || 'Chat request failed.'}`,
          timestamp: new Date().toISOString(),
        }],
      });
    } finally {
      setStreamConversationId((current) => (
        current === conversationId ? null : current
      ));
    }
  }, [streamChat, updateConversation]);

  const submit = useCallback(() => {
    if (!activeConversation || isStreaming) return;
    const ready = attachments.filter((attachment) => attachment.status === 'ready');
    if (!prompt.trim() && ready.length === 0) return;

    const baseMessages = editing
      ? activeConversation.messages.slice(0, editing.index)
      : activeConversation.messages;
    const savedAttachments = serializableAttachments(ready);
    const userMessage = {
      id: editing?.id || makeId(),
      role: 'user',
      content: buildMessageContent({ text: prompt, attachments: ready }),
      displayText: prompt.trim(),
      attachments: savedAttachments,
      timestamp: new Date().toISOString(),
    };
    const nextMessages = [...baseMessages, userMessage];
    const firstUserMessage = nextMessages.find((message) => message.role === 'user');
    const titleText = contentToText(firstUserMessage).trim()
      || savedAttachments[0]?.filename
      || 'Multimodal conversation';
    const title = `${titleText.slice(0, 48)}${titleText.length > 48 ? '…' : ''}`;

    updateConversation(activeConversation.id, {
      messages: nextMessages,
      ...(baseMessages.length === 0 ? { title } : {}),
    });
    setPrompt('');
    setAttachments([]);
    setEditing(null);
    setPageError('');
    runAssistant(
      activeConversation.id,
      nextMessages,
      activeConversation.model,
      artifactContextEnabled ? activeArtifact : null,
    );
  }, [
    activeConversation,
    activeArtifact,
    artifactContextEnabled,
    attachments,
    editing,
    isStreaming,
    prompt,
    runAssistant,
    updateConversation,
  ]);

  const regenerateMessage = useCallback((message) => {
    if (!activeConversation || isStreaming) return;
    const index = activeConversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    const baseMessages = activeConversation.messages.slice(0, index);
    const artifactEdit = message.artifactEditId
      ? activeConversation.artifacts?.find((artifact) => artifact.id === message.artifactEditId)
      : null;
    updateConversation(activeConversation.id, { messages: baseMessages });
    runAssistant(activeConversation.id, baseMessages, activeConversation.model, artifactEdit);
  }, [activeConversation, isStreaming, runAssistant, updateConversation]);

  const editMessage = useCallback((message) => {
    if (!activeConversation || isStreaming) return;
    const index = activeConversation.messages.findIndex((item) => item.id === message.id);
    if (index < 0) return;
    setEditing({ id: message.id, index });
    setPrompt(contentToText(message));
    setAttachments((message.attachments || []).map((attachment) => ({
      ...attachment,
      status: 'ready',
    })));
  }, [activeConversation, isStreaming]);

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setPrompt('');
    setAttachments([]);
  }, []);

  const createConversation = useCallback(() => {
    if (isStreaming) stop();
    createStoredConversation();
    setPrompt('');
    setAttachments([]);
    setEditing(null);
    setActiveArtifactId(null);
    setArtifactContextEnabled(false);
    if (window.innerWidth < 1200) setRailOpen(false);
  }, [isStreaming, stop]);

  const importConversations = useCallback(async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      const normalized = importConversationsIntoStore(parsed);
      if (normalized[0]) {
        setActiveArtifactId(null);
        setArtifactContextEnabled(false);
      }
      setPageError('');
    } catch (error) {
      setPageError(`Import failed: ${error.message}`);
    }
  }, []);

  const updateArtifact = useCallback((artifactId, updater) => {
    if (!activeConversation) return;
    updateConversation(activeConversation.id, (conversation) => ({
      artifacts: (conversation.artifacts || []).map((artifact) => (
        artifact.id === artifactId ? updater(artifact) : artifact
      )),
    }));
  }, [activeConversation, updateConversation]);

  const closeArtifact = useCallback(() => {
    setActiveArtifactId(null);
    setArtifactContextEnabled(false);
    requestAnimationFrame(() => document.getElementById('chat-prompt')?.focus());
  }, []);

  if (!activeConversation) {
    return <div className="chat-page-shell" aria-busy="true" />;
  }

  return (
    <div className={`chat-page-shell ${embedded ? 'chat-page-shell--embedded' : ''}`}>
      {!embedded && (
        <ConversationSidebar
          activeId={activeConversation.id}
          conversations={conversations}
          open={railOpen}
          onClose={() => setRailOpen(false)}
          onCreate={createConversation}
          onDelete={deleteConversation}
          onImport={importConversations}
          onRename={renameConversation}
          onSelect={(id) => {
            selectConversation(id);
            setPrompt('');
            setAttachments([]);
            setEditing(null);
            setActiveArtifactId(null);
            setArtifactContextEnabled(false);
          }}
        />
      )}
      <main className={`chat-main ${activeArtifact ? 'has-workbench' : ''}`}>
        <section className="chat-stage" aria-label="Chat">
          {!embedded && (
            <header className="chat-stage-header">
              <button
                type="button"
                className="chat-icon-btn"
                aria-label="Open conversations"
                onClick={() => setRailOpen(true)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 6h16M4 12h16M4 18h10" />
                </svg>
              </button>
              <div className="chat-stage-title">
                <strong>{activeConversation.title}</strong>
                <span>{activeConversation.messages.length} messages</span>
              </div>
              <button
                type="button"
                className="chat-icon-btn"
                aria-label="New conversation"
                onClick={createConversation}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </header>
          )}
          {pageError && (
            <div className="chat-page-error" role="alert">
              <span>{pageError}</span>
              <button type="button" onClick={() => setPageError('')}>Dismiss</button>
            </div>
          )}
          <MessageList
            artifacts={activeConversation.artifacts || []}
            messages={activeConversation.messages}
            streamingMessage={streamingMessage}
            routedModel={routedModel}
            isStreaming={isStreaming && streamConversationId === activeConversation.id}
            onEdit={editMessage}
            onOpenArtifact={(id) => {
              setActiveArtifactId(id);
              setArtifactContextEnabled(true);
            }}
            onRegenerate={regenerateMessage}
            onSuggestion={setPrompt}
            onDropFiles={(files) => {
              const { audios, images, videos } = partitionMediaFiles(files);
              addAudioFiles(audios);
              addImages(images);
              addVideoFiles(videos);
            }}
          />
          <Composer
            artifactContext={artifactContextEnabled ? activeArtifact : null}
            attachments={attachments}
            disabled={!healthy}
            editing={editing}
            isStreaming={isStreaming}
            model={activeConversation.model || 'auto'}
            models={models}
            onCancelEdit={cancelEdit}
            onChange={setPrompt}
            onDismissArtifactContext={() => setArtifactContextEnabled(false)}
            onAudioFiles={addAudioFiles}
            onImageFiles={addImages}
            onLongText={addLongText}
            onModelChange={(model) => updateConversation(activeConversation.id, { model })}
            onRemoveAttachment={(id) => setAttachments((current) => (
              current.filter((attachment) => attachment.id !== id)
            ))}
            onRetryAttachment={retryAttachment}
            onStop={stop}
            onSubmit={submit}
            onUrl={addVideoUrl}
            onVideoFiles={addVideoFiles}
            value={prompt}
          />
        </section>
        {activeArtifact && (
          <ArtifactWorkbench
            artifact={activeArtifact}
            onClose={closeArtifact}
            onCommit={(content) => updateArtifact(
              activeArtifact.id,
              (artifact) => pushArtifactVersion(artifact, content, { source: 'user' }),
            )}
            onNavigate={(delta) => updateArtifact(
              activeArtifact.id,
              (artifact) => moveArtifactVersion(artifact, delta),
            )}
            onRename={(title) => updateArtifact(
              activeArtifact.id,
              (artifact) => ({ ...artifact, title }),
            )}
          />
        )}
      </main>
      {pageNotice && <div className="chat-toast glass-panel" role="status">{pageNotice}</div>}
    </div>
  );
}

export default ChatPage;
