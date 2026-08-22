# Documentation Page Design

In-app documentation for Llama Manager features and configuration.

## Motivation

Users need accessible documentation without leaving the application. Key topics include local CLI and agent usage, MCP setup, API usage, and feature explanations.

## User Stories

- As a user, I want to learn how to set up MCP integration with Claude Desktop
- As a user or local agent, I want complete CLI workflows and machine-readable help
- As a user, I want to see API examples without switching to external docs
- As a user, I want to understand the difference between router and single mode

## Design

### Overview

A documentation page with section navigation and formatted content including code blocks.

### UI/UX

**Route:** `/docs`

**Layout:**
```
┌──────────────────────────────────────────────────────────────┐
│ Sidebar (200px)        │ Main Content Area                   │
│ ┌────────────────────┐ │ ┌──────────────────────────────────┐│
│ │ Overview           │ │ │ # Section Title                  ││
│ │ MCP Setup          │ │ │                                  ││
│ │ API Usage          │ │ │ Content with formatted text,     ││
│ │ Features           │ │ │ code blocks, and examples.       ││
│ │   └─ Router Mode   │ │ │                                  ││
│ │   └─ Single Mode   │ │ │ ```bash                          ││
│ │   └─ Presets       │ │ │ curl example     [Copy]          ││
│ │                    │ │ │ ```                              ││
│ └────────────────────┘ │ └──────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### Sections

1. **Overview**
   - What is Llama Manager
   - Key features
   - Quick start guide

2. **MCP Setup**
   - What is MCP
   - Claude Desktop configuration
   - Environment variables
   - Available MCP tools

3. **Local CLI**
   - Source and package installation locations
   - Human, JSON, dotted, and GraphQL-shaped output
   - Ergonomic commands plus complete OpenAPI/raw request access
   - Search, download, load, and verify workflow for Qwen3.8-27B

4. **API Usage**
   - Base URLs
   - Authentication (none required)
   - curl examples
   - OpenAI SDK usage

5. **Features**
   - Router mode explanation
   - Single-model mode
   - Presets configuration
   - Download management

### Features

1. **Code Blocks**
   - Syntax highlighting (basic)
   - Copy-to-clipboard button
   - Language indicator

2. **Navigation**
   - Sticky sidebar
   - Active section highlight
   - Smooth scroll to section

3. **Content**
   - Markdown-like formatting
   - Tables for reference data
   - External links

## Implementation

### Files to Modify

- `ui/src/App.jsx` - Add DocsPage component
- `ui/src/App.css` - Add documentation styles

### CSS Classes

```css
.docs-page
.docs-layout
.docs-sidebar
.docs-nav
.docs-nav-item
.docs-nav-item.active
.docs-nav-item.nested
.docs-content
.docs-section
.docs-code-block
.docs-code-header
.docs-copy-btn
.docs-table
```

### Content Structure

Documentation content is defined as React components with sections:

```jsx
const DOCS_SECTIONS = [
  { id: 'overview', title: 'Overview', content: OverviewContent },
  { id: 'mcp-setup', title: 'MCP Setup', content: MCPSetupContent },
  { id: 'api-usage', title: 'API Usage', content: APIUsageContent },
  { id: 'features', title: 'Features', content: FeaturesContent },
];
```

## Testing

### Manual Testing

1. Navigate to /docs
2. Verify all sections render correctly
3. Click sidebar items, verify scroll to section
4. Test copy button on code blocks
5. Verify external links open in new tab

### Edge Cases

- Long code blocks: Horizontal scroll
- Small screens: Responsive layout
