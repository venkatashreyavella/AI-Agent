# Architecture and implementation plan

## Phase 1: architecture

The browser presents chat and keeps a small conversation history in local storage. It sends the bounded conversation context to a same-origin FastAPI endpoint. FastAPI validates message roles and sizes, adds the configured system instruction, and calls an OpenAI-compatible streaming endpoint using server-only credentials. The API translates model deltas into SSE events; the browser renders them as they arrive. Provider errors are returned as safe user-facing events and do not expose upstream response bodies or credentials.

This MVP chooses a single model adapter and avoids an agent framework until tool semantics and approval policies are designed. The provider adapter is isolated so other vendors can be added behind the same contract. Conversation history is local and therefore available only in the same browser profile; there is no account or server persistence yet.

## Phase 2: shipped MVP

- FastAPI static hosting and `/api/health`.
- Streaming `/api/chat/stream` endpoint with bounded input and configurable output.
- OpenAI-compatible chat completion provider using `httpx`.
- Responsive dark/light UI, local conversation list, markdown-like formatting, and streaming status.
- `.env.example`, dependency list, and local run instructions.

## Data flow

1. User enters a prompt. UI appends it to the selected local conversation.
2. UI posts the prior messages to the streaming endpoint.
3. API validates and forwards the content to the model provider.
4. Provider chunks arrive as SSE `delta` events; completion/error arrives as `done`/`error`.
5. UI updates the assistant message and persists completed turns locally.

## Follow-on phases

- Phase 3: explicit task planner and typed tool registry. Each tool gets a narrow schema, execution timeout, audit record, and approval policy. Do not permit arbitrary shell execution in the API process.
- Phase 4: document extraction, web retrieval with citations, persistent memory with user controls, and isolated code execution. Add storage retention and deletion policies before server-side history.
- Phase 5: unit/integration tests, provider contract tests, prompt-injection evaluations, and tool permission tests.
- Phase 6: production observability, rate limiting, persistent accounts, and deployment operations for the target hosting platform. A Render deployment blueprint and password gate are now included.

## Public hosting

`render.yaml` defines a Render free web service. In production, startup fails unless `APP_ACCESS_PASSWORD` is at least 14 characters. The chat API checks that password using a constant-time comparison; the browser keeps it in session storage and sends it over the host's HTTPS connection. The model key is configured as a host secret and never added to the repository. Free hosting may sleep while idle, so the first visit after inactivity can be delayed.
