Fix routing variable declaration order causing crash

Move `const routing = resolveBackend(...)` before `startActiveRequest()`
call in chat/completions handler. The previous order referenced `routing`
before it was declared, causing "Cannot access 'routing' before
initialization" ReferenceError on incoming requests.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
