// Llama Manager — rich chat message presentation.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders right-aligned user chips, full-width sanitized assistant Markdown,
// multimodal previews, routed-model metadata, and per-message actions.

import { Fragment, useState } from 'react';

import { copyTextToClipboard, formatModelName } from '../../api.js';
import { CodeBlock } from '../CodeBlock.jsx';
import { formatMediaTime } from './attachments.js';

function safeHref(value) {
  try {
    const url = new URL(value, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? value : '#';
  } catch {
    return '#';
  }
}

function renderInline(text, prefix) {
  const expression = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\[[^\]\n]+\]\([^) \n]+\))/g;
  const output = [];
  let cursor = 0;
  let match;
  let index = 0;
  while ((match = expression.exec(text)) !== null) {
    if (match.index > cursor) output.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${prefix}-${index++}`;
    if (token.startsWith('`')) {
      output.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      output.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      output.push(<del key={key}>{token.slice(2, -2)}</del>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      output.push(
        <a key={key} href={safeHref(link[2])} target="_blank" rel="noreferrer">
          {link[1]}
        </a>,
      );
    }
    cursor = match.index + token.length;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

function isTableDivider(line) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  return !line.trim()
    || /^```/.test(line)
    || /^#{1,6}\s/.test(line)
    || /^>\s?/.test(line)
    || /^[-*+]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || /^---+$/.test(line.trim())
    || (line.includes('|') && isTableDivider(lines[index + 1] || ''));
}

/**
 * Deliberately ignores raw HTML. React escapes all text nodes and link schemes
 * are allowlisted, providing sanitization without injecting parsed HTML.
 */
function Markdown({ content }) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w+-]*)\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock
          key={`code-${index}`}
          code={code.join('\n')}
          language={fence[1]}
        />,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}`;
      blocks.push(<Tag key={`heading-${index}`}>{renderInline(heading[2], `h-${index}`)}</Tag>);
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const headers = splitTableRow(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(
        <div className="chat-markdown-table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>{headers.map((cell, cellIndex) => (
                <th key={cellIndex}>{renderInline(cell, `th-${index}-${cellIndex}`)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInline(row[cellIndex] || '', `td-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3]);
        index += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={`list-${index}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>
          ))}
        </List>,
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quote.map((quoteLine, quoteIndex) => (
            <Fragment key={quoteIndex}>
              {quoteIndex > 0 && <br />}
              {renderInline(quoteLine, `quote-${index}-${quoteIndex}`)}
            </Fragment>
          ))}
        </blockquote>,
      );
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`paragraph-${index}`}>
        {paragraph.map((paragraphLine, paragraphIndex) => (
          <Fragment key={paragraphIndex}>
            {paragraphIndex > 0 && <br />}
            {renderInline(paragraphLine, `p-${index}-${paragraphIndex}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return blocks;
}

function contentToText(message) {
  if (message.displayText != null) return message.displayText;
  if (typeof message.content === 'string') return message.content;
  return (message.content || [])
    .filter((part) => part.type === 'text' && !/^\[(?:frame|video):?/.test(part.text))
    .map((part) => part.text)
    .join('\n');
}

function UserAttachments({ message }) {
  if (message.attachments?.length) {
    return (
      <div className="chat-sent-attachments">
        {message.attachments.map((attachment) => (
          <div className="chat-sent-attachment" key={attachment.id || attachment.filename}>
            {attachment.kind === 'image' ? (
              <img src={attachment.dataUrl} alt={attachment.filename || 'Attached image'} />
            ) : (
              <span className="chat-sent-video">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5h16v14H4zM8 5v14M16 5v14" />
                </svg>
                <span>
                  {attachment.filename}
                  {attachment.kind === 'video' && ` · ${formatMediaTime(attachment.durationSec)}`}
                </span>
              </span>
            )}
          </div>
        ))}
      </div>
    );
  }
  if (Array.isArray(message.content)) {
    return (
      <div className="chat-sent-attachments">
        {message.content.filter((part) => part.type === 'image_url').map((part, index) => (
          <div className="chat-sent-attachment" key={index}>
            <img src={part.image_url.url} alt="Attached image" />
          </div>
        ))}
      </div>
    );
  }
  return null;
}

function ActionIcon({ type }) {
  if (type === 'copy') return <path d="M8 8h11v11H8zM5 16H4V4h12v1" />;
  if (type === 'edit') return <path d="m4 16-1 5 5-1L19 9l-4-4L4 16ZM13 7l4 4" />;
  return <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" />;
}

/**
 * One persisted or currently streaming chat message.
 */
function Message({ message, isStreaming = false, onEdit, onRegenerate }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';
  const displayText = contentToText(message);
  const copy = async () => {
    await copyTextToClipboard(displayText || String(message.content || ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <article
      className={`chat-message-row ${isUser ? 'is-user' : 'is-assistant'} ${isStreaming ? 'is-streaming' : ''}`}
      aria-live={isUser ? undefined : 'polite'}
    >
      <div className="chat-message-topline">
        {!isUser && (
          <div className="chat-assistant-label">
            <span className="chat-assistant-mark">L</span>
            <span>Assistant</span>
            {message.routedModel && (
              <span className="glass-chip chat-route-badge">
                {formatModelName({ id: message.routedModel })}
              </span>
            )}
            {message.stopped && <span className="chat-stopped-label">Stopped</span>}
          </div>
        )}
        <div className="chat-message-tools">
          <button type="button" onClick={copy} aria-label="Copy message" title="Copy">
            <svg viewBox="0 0 24 24" aria-hidden="true"><ActionIcon type="copy" /></svg>
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          {isUser && onEdit && (
            <button type="button" onClick={() => onEdit(message)} aria-label="Edit message" title="Edit">
              <svg viewBox="0 0 24 24" aria-hidden="true"><ActionIcon type="edit" /></svg>
              <span>Edit</span>
            </button>
          )}
          {!isUser && !isStreaming && onRegenerate && (
            <button type="button" onClick={() => onRegenerate(message)} aria-label="Regenerate response" title="Regenerate">
              <svg viewBox="0 0 24 24" aria-hidden="true"><ActionIcon type="regenerate" /></svg>
              <span>Regenerate</span>
            </button>
          )}
        </div>
      </div>
      {isUser ? (
        <div className="chat-user-bubble glass-chip">
          <UserAttachments message={message} />
          {displayText && <div className="chat-user-text">{displayText}</div>}
        </div>
      ) : (
        <div className="chat-assistant-content">
          {message.content ? <Markdown content={message.content} /> : (
            isStreaming && (
              <span className="chat-thinking" aria-label="Assistant is thinking">
                <i /><i /><i />
              </span>
            )
          )}
          {isStreaming && message.content && <span className="chat-stream-caret" aria-hidden="true" />}
        </div>
      )}
      {!isUser && message.stats && !isStreaming && (
        <div className="chat-message-stats">
          {message.stats.tokensPerSecond} tok/s
          <span>·</span>
          {message.stats.completionTokens} tokens
          <span>·</span>
          {(message.stats.duration / 1000).toFixed(1)}s
        </div>
      )}
    </article>
  );
}

export { Markdown, Message, contentToText };
