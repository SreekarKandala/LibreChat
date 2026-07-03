# Architecture

This fork of LibreChat is a **headless agents API**: no web UI, no login, one
service user. It exists to serve the Gosure Angular app
(`cokube-angular/src/app/services/librechat-api.service.ts`), which uses it for
agent CRUD, agent actions, and streaming chat. Everything else upstream offers
was removed or is dormant.

If you read only one section, read [The two request paths](#the-two-request-paths).

---

## The 30-second mental model (for Spring Boot people)

| Spring Boot | This codebase | Where |
|---|---|---|
| `@RestController` | Express **routes** (URL + middleware chain) and **controllers** (handler functions) | `api/server/routes/`, `api/server/controllers/` |
| Filters / interceptors | **Middleware** — plain functions `(req, res, next)` that run in mount order before the handler | `api/server/middleware/` |
| `@Service` | **Services** — plain modules of functions | `api/server/services/` |
| JPA repositories + entities | **Mongoose models + methods** (MongoDB, schema-on-write) | `packages/data-schemas/src/{schema,models,methods}` |
| DTOs / shared interfaces | **TypeScript types + enums** shared with any client | `packages/data-provider/src/` |
| Beans / DI container | None — modules `require()` each other directly; "injection" is passing functions as arguments | everywhere |
| Threads per request | **Single-threaded event loop** — every I/O call is `async/await`; nothing blocks | everywhere |

Two Node-specific ideas with no Spring equivalent you'll meet immediately:

- **Middleware order is the security model.** A request to `/api/agents/:id`
  passes through `requireJwtAuth` (attaches the service user), then
  `canAccessAgentResource` (ACL check), then the handler. Reading a route file
  top-to-bottom *is* reading the request lifecycle.
- **SSE (Server-Sent Events)** is how chat streams. The client makes a normal
  GET request and the server keeps the connection open, writing
  `data: {...}\n\n` frames as the model generates. It is one-directional
  (server→client) — simpler than WebSockets.

## Monorepo layout

```
api/                    The Express application (JavaScript). The actual server process.
  server/index.js       Startup + every route mount. START READING HERE.
  server/routes/        URL definitions + middleware chains
  server/controllers/   Request handlers
  server/services/      Business logic (ActionService, ToolService, Endpoints/…)
  server/middleware/    requireJwtAuth (service-user identity), ACL guards, limiters
  app/clients/          Legacy client base classes + tool implementations
  models/               Thin re-export of data-schemas methods (`require('~/models')`)
packages/api/           "@librechat/api" — TypeScript engine library (no server of its own).
                        Job/SSE stream manager, action executor, config loading, crypto,
                        storage backends, MCP. Compiled to dist/, consumed by api/.
packages/data-schemas/  Mongoose schemas, models, and DB methods (findUser, getAgent, …)
packages/data-provider/ Shared TS types, enums, permission bits
config/                 Operational CLI scripts (create-user, flush-cache, …)
client/public/images/   NOT code — the upload data directory (avatars), served at /images
scripts/smoke.mjs       The regression check. `npm run smoke` against a running backend.
```

External black box: **`@librechat/agents`** (npm dependency) — the LangGraph
run loop that actually calls OpenAI and emits generation events. We own what
goes *in* (agent config, tools) and what comes *out* (events); not its internals.

## Identity: there is no login

`api/server/middleware/requireJwtAuth.js` no longer does JWT anything: it loads
the user named by `SERVICE_USER_EMAIL` (once, cached) and attaches it as
`req.user` for every request. All data — agents, conversations, messages —
belongs to that one user. **Consequence: the API trusts every network caller.
It must never be directly internet-exposed**; the Angular app's own auth
barrier plus network isolation is the security model (see ENVIRONMENTS.md).

---

## The two request paths

### Path 1 — Agent CRUD (`GET/POST/PATCH/DELETE /api/agents…`)

```
api/server/index.js            mounts /api/agents
  └─ routes/agents/index.js    applies requireJwtAuth, mounts sub-routers
      └─ routes/agents/v1.js   route table: each route = [ACL guard] + handler
          └─ canAccessAgentResource        middleware/accessResources/ — checks the
             (VIEW/EDIT/DELETE bits)        aclentries collection for this agent
          └─ controllers/agents/v1.js      createAgent / getAgent / updateAgent /
                                           deleteAgent / getListAgents / avatar upload
              └─ packages/data-schemas     Agent model + methods (createAgent,
                                           getAgent, updateAgent, getListAgentsByAccess)
```

Facts worth knowing:
- **Listing is ACL-driven**: `getListAgents` doesn't query "all agents" — it asks
  the ACL for resources the user can access, then fetches those. This is why the
  ACL layer survived the pruning: creation writes an ACL "owner" entry, and
  listing reads it back.
- Agents are **versioned**: every update appends to a `versions` array on the
  document (`getAgentVersions`, revert endpoint).
- Avatars go through `POST /api/files/images/agents/:agent_id/avatar` →
  `services/Files/` → written to `client/public/images/<userId>/`, served at `/images`.

### Path 2 — Chat with tool calls (`POST /api/agents/chat` + SSE)

```
POST /api/agents/chat
  └─ routes/agents/index.js         requireJwtAuth; readiness gate
      └─ routes/agents/chat.js      middleware chain, in order:
           restoreResumeContext       (only for /resume)
           createMessageFilterPii     optional PII scrub
           moderateText               optional OpenAI moderation
           canAccessAgentFromBody     ACL check on agent_id in the body
           validateConvoAccess        conversation ownership
           buildEndpointOption        normalizes body into req.body.endpointOption
      └─ controllers/agents/request.js
           creates a GenerationJob (streamId == conversationId),
           RETURNS IMMEDIATELY with { streamId }, generation continues in
           the background                                  ◄── key design
      └─ services/Endpoints/agents/initialize.js
           loads the agent, resolves its tools (ToolService), builds the client
      └─ controllers/agents/client.js
           drives @librechat/agents (the LLM loop); every generation event is
           forwarded via controllers/agents/callbacks.js →
           GenerationJobManager.emitChunk(streamId, event)

GET /api/agents/chat/stream/:streamId          (the Angular client calls this next)
  └─ routes/agents/index.js  subscribes this HTTP response to the job's event
     stream; replays missed chunks (that's why streams are "resumable"), then
     writes live SSE frames until the `final` event.

Tool call branch (during generation):
  └─ services/ToolService.js        turns the agent's tools into callables
      └─ services/ActionService.js  ◄── THE FILE TO KNOW BEST
           decrypts action metadata (CREDS_KEY/CREDS_IV),
           overrides metadata.api_key with the request's  x-gosure-token
           header for service_http actions (our one upstream customization),
           builds an SSRF-guarded HTTP executor, calls https://dev.gosure.ai,
           returns the response to the model

After the final event:
  - message + conversation saved (models saveMessage/saveConvo)
  - title generated for new conversations (services/Endpoints/agents/title.js)
  - token usage recorded as a Transaction (spend tracking)
```

The job/stream split matters: the POST and the SSE GET are **two separate HTTP
requests** glued together by `GenerationJobManager`
(`packages/api/src/stream/`) which buffers events in memory. A dropped client
can reconnect with `?resume=true` and replay what it missed.

## Supporting cast (have a map, not mastery)

| Concern | Entry point | What it does |
|---|---|---|
| `/api/endpoints`, `/api/models` | `services/Config/` | Builds the "what providers/models exist" answer from env vars (+ `librechat.yaml` if present) |
| `/api/convos`, `/api/messages` | `routes/convos.js`, `routes/messages.js` | Straight CRUD over conversation/message models |
| `/api/categories` | `routes/categories.js` | 15 lines; the best first read |
| File uploads / avatars | `routes/files/`, `services/Files/Local/` | Multer upload → local disk strategy |
| Startup checks & seeding | `api/server/index.js` + `models/seedDatabase` | Roles/grants/categories seeded on boot |
| Caching / rate limits | `api/cache/`, `middleware/limiters/` | In-memory (Keyv) unless Redis configured |
| Logging | `winston` → console + `api/logs/*.log` | Errors land in `logs/error-*.log`; `DEBUG_LOGGING=true` for verbose |

## Dormant code (know it exists, then ignore it)

Kept deliberately as future optionality; none of it runs in this deployment:

- **Other LLM providers**: Anthropic / Google / Bedrock / Azure adapters
  (`services/Endpoints/*`, `packages/api/src/endpoints/`) — activate by env var.
- **Cloud file storage**: S3 / Azure Blob / Firebase (`services/Files/*`,
  `packages/api/src/storage/`) — activate by `fileStrategy` config.
- **MCP** (`packages/api/src/mcp/`): pluggable external tool servers — an
  alternative to actions; no servers configured.
- **Speech / OCR / RAG plumbing**: STT/TTS routes under `/api/files/speech`,
  OCR services, RAG-API client — all unconfigured.
- **Assistants controllers/services** (`controllers/assistants/`,
  `services/Endpoints/assistants/`): the OpenAI Assistants API integration.
  Its HTTP routes are deleted, but kept modules import helpers from here.

## Operational notes

- **Run**: `npm run backend` (or `start:dev|demo|uat` for per-env `.env` files).
- **Verify**: `npm run smoke` against the running server — this is the test suite.
- **Env contract**: `MONGO_URI`, `SERVICE_USER_EMAIL`, `CREDS_KEY`/`CREDS_IV`
  (encrypt action credentials at rest — a matched pair with the DB; rotating
  them orphans stored encrypted values), `JWT_SECRET` (still used to sign
  action-OAuth state tokens), provider keys (`OPENAI_API_KEY`).
- **Frozen fork**: upstream merges are no longer possible. Tag `pre-prune`
  (pushed to origin) is the full pre-pruning snapshot.

---

## Learning path (for a frontend developer)

Fluent TypeScript is a real head start — `packages/api` and the type layer are
TS, and the JS in `api/` is modern (async/await, destructuring). What will be
new is server-side *shape*: middleware chains, streaming responses, and
process lifecycle. The plan attacks those directly. Each stage ends with
something you *do*, because the doing is what makes it stick.

**Stage 1 — One trivial request, end to end (½ day).**
Read `api/server/index.js` top to bottom, then `routes/categories.js` (15
lines), then `middleware/requireJwtAuth.js` (we wrote it; ~45 lines). Trace in
your head: TCP request → Express matches mount → middleware chain → handler →
Mongoose → JSON out. *Do*: add a temporary `console.log(req.method, req.path)`
middleware in `index.js`, restart, click around your Angular app, watch the
requests land. Delete it after.

**Stage 2 — Agent CRUD (1–2 days).**
Read `routes/agents/v1.js` (the route table), then `controllers/agents/v1.js`
handler by handler, jumping into the data-schemas methods they call. Keep the
Spring mapping in mind: route file = `@RequestMapping` table, controller =
method bodies, data-schemas = repository. *Do*: in `mongosh` (or Compass),
inspect the `agents`, `aclentries`, `conversations`, and `messages` collections
— seeing the documents makes the model code obvious. Then create an agent from
your Angular UI and watch the new `agents` + `aclentries` documents appear.

**Stage 3 — Conversations & messages (½ day).**
Read `routes/convos.js` and `routes/messages.js` and their models. Note the
shape: messages form a tree via `parentMessageId` (your Angular service
already sorts by it). *Do*: `npm run smoke`, then find the smoke-test
conversation in Mongo and follow its message chain by hand.

**Stage 4 — The chat pipeline (2–3 days; the real one).**
Read in this order, following one imaginary request:
`routes/agents/chat.js` (middleware chain) → `controllers/agents/request.js`
(job creation; notice it responds *before* generation finishes) →
`services/Endpoints/agents/initialize.js` → `controllers/agents/client.js`
(skim — it's long; focus on where events are emitted) →
the SSE route in `routes/agents/index.js`. *Do*: open your Angular app's chat
in DevTools → Network → the `stream/...` request → EventStream tab, and match
each frame type you see against the code that emitted it. You have already
done this once during debugging; now do it knowing the source.

**Stage 5 — Actions: your integration (1 day).**
Read `services/ActionService.js` slowly — decryption, the `x-gosure-token`
override, the OAuth branch (dormant for you), the executor call. Then the
actions routes in `routes/agents/actions.js`. *Do*: chat with a tool-calling
agent while tailing `api/logs/` with `DEBUG_LOGGING=true`, and re-read the
event flow in your network tab.

**Stage 6 — Boot & config (½ day).**
Re-read `api/server/index.js` knowing everything above, then skim
`services/Config/` (where `/api/endpoints` and `/api/models` answers come
from) and `packages/data-schemas/src/schema/` for the collections you now
recognize. *Do*: break something on purpose — unset `SERVICE_USER_EMAIL`,
boot, read the error; set it back. Owning a service is mostly knowing its
failure messages.

After stage 6 you will know, for any request your Angular app makes, exactly
which files it touches — which is what "owning this service" means. Total
investment: roughly one focused week. The dormant subsystems need none of it;
read them the day you turn one on.
