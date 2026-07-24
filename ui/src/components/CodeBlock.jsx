// Llama Manager — highlighted code block rendering.
// Copyright (c) Llama Manager project. Use of this file is governed by the
// LICENSE file in the repository root.
//
// Renders copyable syntax-highlighted code blocks and parses message text into
// plain spans and fenced code blocks.

import React, { useState, useEffect, useRef } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { copyTextToClipboard } from '../api.js';

// Code block component with syntax highlighting and copy button
function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);
  const codeRef = useRef(null);

  useEffect(() => {
    if (codeRef.current && language) {
      // Reset any previous highlighting
      codeRef.current.removeAttribute('data-highlighted');
      try {
        hljs.highlightElement(codeRef.current);
      } catch (e) {
        // Language not supported, fall back to plain text
      }
    }
  }, [code, language]);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleOpenHtml = () => {
    const blob = new Blob([code], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Clean up the blob URL after a delay
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const isHtml = language?.toLowerCase() === 'html';

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'text'}</span>
        <div className="code-block-actions">
          {isHtml && (
            <button className="code-block-open" onClick={handleOpenHtml} title="Open HTML in new tab">
              Open
            </button>
          )}
          <button className="code-block-copy" onClick={handleCopy} title="Copy code">
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre>
        <code ref={codeRef} className={language ? `language-${language}` : ''}>
          {code}
        </code>
      </pre>
    </div>
  );
}

// Parse message content and render code blocks with syntax highlighting
function parseMessageWithCodeBlocks(content) {
  if (typeof content !== 'string') return content;

  // Regex to match complete code blocks: ```language\ncode\n```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const parts = [];
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Add text before the code block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      parts.push(<span key={key++}>{textBefore}</span>);
    }

    // Add the code block
    const language = match[1] || '';
    const code = match[2].trim();
    parts.push(<CodeBlock key={key++} code={code} language={language} />);

    lastIndex = match.index + match[0].length;
  }

  // Check for unclosed code block at the end (streaming)
  const remaining = content.slice(lastIndex);
  const unclosedMatch = remaining.match(/```(\w*)\n?([\s\S]*)$/);

  if (unclosedMatch) {
    // Add text before the unclosed code block
    const textBefore = remaining.slice(0, unclosedMatch.index);
    if (textBefore) {
      parts.push(<span key={key++}>{textBefore}</span>);
    }
    // Add the unclosed code block (still being streamed)
    const language = unclosedMatch[1] || '';
    const code = unclosedMatch[2] || '';
    parts.push(<CodeBlock key={key++} code={code} language={language} />);
  } else if (remaining) {
    // Add any remaining text after the last code block
    parts.push(<span key={key++}>{remaining}</span>);
  }

  return parts.length > 0 ? parts : content;
}

export { CodeBlock, parseMessageWithCodeBlocks };
