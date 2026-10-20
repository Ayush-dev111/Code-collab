# Collab platform

Phases 0, 1, 3, 4 and 5, plus the required Phase 2 realtime infrastructure, of
`Live Collaboration Platform Build Plan.docx` are implemented. The Phase 3 scope
included the missing realtime prerequisites at the user's request.

Users can create projects, invite members, manage a page/code/folder tree, and
edit BlockNote pages and Monaco code files together through Yjs. The server
enforces OWNER / EDITOR / VIEWER permissions for HTTP requests, Socket.IO events,
and Yjs connections and messages.
Phase 6 application code and Phase 7 live chat are implemented. Phase 6's real
Docker sandbox acceptance is pending because this Windows workspace has no Docker
or usable WSL. Phase 8 hardening is implemented; its local verification and
remaining external checks are recorded below.

Documents persist in PostgreSQL. Online avatars and named, colored cursors use
server-verified identities. The sidebar shows everyone online across the project
and links to the pages or files they are viewing, with multiple tabs grouped per
person. Code files now have shared run output and history when Judge0 and Redis
are configured. Project chat has persistent history, typing indicators, and
viewer access. User code is sent only to Judge0;
neither application executes it locally.

## Prerequisites

- Node.js 24 LTS, version 24.13.1 or newer in the 24.x line.
- pnpm 12.9.1, pinned in the root `packageManager`.
- Docker Desktop with Linux containers and Compose v2 for the standard setup.
- Available ports: 3000, 3001, 5432, 6379, and optionally 5555 for Prisma Studio.

This workspace has no Docker Desktop or usable WSL. A portable PostgreSQL 18.6
instance under ignored `.tools` is used for local verification. Phase 6 uses
Redis for run rate limits and leases. Phase 8 also requires Redis for chat sends
and invitation creation, preview, and joins. These actions return a clear error
when Redis is unavailable; reading existing chat and editing documents still work.

## First setup

Run in PowerShell from `D:\collab` (or your checkout directory). If pnpm is already
on PATH, omit the first two commands.

```powershell
npm.cmd install --prefix .tools pnpm@12.9.1 --no-save --package-lock=false
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd install --frozen-lockfile --store-dir .tools/pnpm-store
Copy-Item .env.example .env
node --input-type=module -e "import {readFileSync,writeFileSync} from 'node:fs'; import {randomBytes} from 'node:crypto'; const path='.env'; let text=readFileSync(path,'utf8'); for(const key of ['BETTER_AUTH_SECRET','REALTIME_TOKEN_SECRET','REALTIME_INTERNAL_SECRET']) text=text.replace(new RegExp('^'+key+'=.*$','m'),key+'='+randomBytes(32).toString('hex')); writeFileSync(path,text);"
pnpm.cmd infra:up
pnpm.cmd db:migrate:deploy
pnpm.cmd db:verify
pnpm.cmd dev
```

Copy the environment and generate three independent secrets only on first setup.
Retain the existing `.env` on later runs; replacing the auth secret invalidates
existing sessions. This workspace already has generated secrets. They are never
committed or sent to the browser.

Open <http://127.0.0.1:3000>. The home route takes you to your projects after
authentication, or to sign-in. Use this exact host consistently: cookies, OAuth
callbacks, and mutation origin checks use `BETTER_AUTH_URL`. The separate
realtime server listens at <http://127.0.0.1:3001/health>, hosts Yjs at `/yjs`, and
hosts Socket.IO on the same port. `REALTIME_URL` is the browser WebSocket origin;
`REALTIME_HTTP_URL` is the server notification origin. Both applications must use
the same realtime secrets and database.

The web bootstrap loads the monorepo's root `.env` using Node's built-in
`loadEnvFile`. This avoids forwarding the Node `--env-file` startup flag into a
Next.js worker that rejects it.

## Run this existing workspace without Docker

The portable binaries and database are ignored development artifacts, not
dependencies required by a clean checkout. PostgreSQL is already running in this
workspace. If it has been stopped, start it with:

```powershell
.\.tools\postgres-runtime\pgsql\bin\pg_ctl.exe -D .tools\postgres-data -l .tools\postgres.log -o '-h 127.0.0.1 -p 5432' -w start
```

Then run:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd install --frozen-lockfile --store-dir .tools/pnpm-store
pnpm.cmd db:migrate:deploy
pnpm.cmd dev
```

In a second terminal, from the same root:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd test:phase1
pnpm.cmd test:phase3
pnpm.cmd test:phase3:browser
pnpm.cmd test:phase4
pnpm.cmd test:phase4:browser
```

The smoke scripts create temporary accounts/projects, exercise real HTTP and
realtime connections, and remove their own records with cleanup guards. The
browser test drives an installed Chrome or Edge through Node's native CDP tools,
using four isolated browser contexts and an ignored temporary profile. It never
opens your personal browser profile. Set `CHROME_PATH` if automatic discovery
does not find your browser. No Playwright or additional testing library is needed.

The same smoke test can run against `pnpm.cmd --filter @collab/web start` after
a production build. It respects Better Auth's production rate limit by waiting
for its retry header before repeating a limited authentication request.

Optional Studio:

```powershell
pnpm.cmd db:studio
```

Open <http://localhost:5555>. Stop app processes with Ctrl+C. The portable database
can be stopped with:

```powershell
.\.tools\postgres-runtime\pgsql\bin\pg_ctl.exe -D .tools\postgres-data -m fast -w stop
```

Stop it before switching to Docker, since both use port 5432. Docker and the
portable cluster contain separate data. `pnpm.cmd infra:down` stops Compose
services and keeps their volumes.

## Google and GitHub sign-in

Email/password works without external provider credentials. Passwords for new
accounts must contain 10 to 128 characters.

To enable a provider, create its OAuth application and set both matching entries
in the root `.env`, then restart the app:

| Provider | Environment variables                      | Callback for the default local URL               |
| -------- | ------------------------------------------ | ------------------------------------------------ |
| Google   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `http://127.0.0.1:3000/api/auth/callback/google` |
| GitHub   | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `http://127.0.0.1:3000/api/auth/callback/github` |

Register callback URLs exactly as shown in your provider console. If a provider
requires a different development hostname, set `BETTER_AUTH_URL` to that origin,
register the corresponding callback, and use that hostname throughout.

An unconfigured provider is disabled in the sign-in UI and refused by the server.
Partial credential pairs fail environment validation. Provider secrets remain on
the server. Actual provider round trips require your credentials and were not
tested in this workspace.

## Page editing and image storage

Create a page or folder from the project sidebar. A page opens at
`/projects/:projectId/:itemId`. Editors can rename, move into a folder or the root,
and choose a sibling position. Move positions describe the destination list after
removing the moved item. Deleting a folder deletes its entire subtree after a
confirmation. Tree mutations lock the project row, recheck permissions, update
orders atomically, and notify connected members through Socket.IO. A delayed
notification displays a warning; reconnecting or focusing the tab refetches the
tree.

BlockNote uses the `blocknote` Y.XmlFragment in the `item:<itemId>` Yjs document.
The editor mounts after the first sync. Headings, lists, checklists, code blocks,
tables, slash commands, images, and remote cursors use BlockNote's default blocks.
Viewers receive live updates with a read-only editor. Avatars reflect people
connected to the current page. Unsynced edits show a warning and a navigation
confirmation. Reconnect preserves the in-memory document and merges pending edits;
offline browser reload persistence is not implemented.

Configure a private S3 bucket before uploading images. The root `.env` accepts:

```dotenv
S3_REGION=us-east-1
S3_BUCKET=your-private-bucket
S3_ACCESS_KEY_ID=your-access-key
S3_SECRET_ACCESS_KEY=your-secret-key
S3_SESSION_TOKEN=
S3_ENDPOINT=
S3_FORCE_PATH_STYLE=false
```

For AWS, leave `S3_ENDPOINT` blank. For another S3-compatible service, set its
HTTP(S) origin without a path, query, or embedded credentials; set
`S3_FORCE_PATH_STYLE=true` when that service requires bucket names in the path.
Use HTTPS for remote services. Temporary credentials may include
`S3_SESSION_TOKEN`. Restart the web app after changing configuration. The server
credential needs GetObject and PutObject permission for the bucket's
`projects/*` prefix. The bucket can remain private; no public ACL is requested.

Node's native crypto and fetch implement the documented S3 Signature V4 protocol,
so no additional SDK was installed. Uploads require current EDITOR permission,
accept PNG/JPEG/GIF/WebP up to 8 MiB, and validate actual file headers. Every image
read rechecks current project membership and its parent page. Stable image URLs
use the authenticated web proxy, keeping bucket credentials on the server.
Missing configuration returns a useful 503 error. Deleted pages lose image
access; stored object lifecycle cleanup is not part of this phase.

No real bucket credentials were provided. Signature and private upload/read
behavior are tested against an isolated local S3 protocol fixture, including an
AWS published signature vector; a real bucket round trip remains a manual check.

## API permissions

Every project read and mutation validates the session and current database
membership. Client role badges and hidden controls are conveniences; access
decisions happen on the server. Cookie caching is disabled for authorization.
All request bodies, path parameters, and query parameters use shared Zod schemas.
Mutations require a matching Origin. JSON bodies are capped at 16 KiB; image
multipart bodies have a separate 8 MiB file limit and bounded overhead.

| Route                                                         | Minimum permission                                |
| ------------------------------------------------------------- | ------------------------------------------------- |
| `GET /api/projects`                                           | Signed in; returns only the user's memberships    |
| `POST /api/projects`                                          | Signed in; creates an OWNER membership atomically |
| `GET /api/projects/:projectId`                                | VIEWER                                            |
| `PATCH /api/projects/:projectId`                              | EDITOR; changes the project name                  |
| `POST /api/projects/:projectId/invites`                       | OWNER; grants EDITOR or VIEWER                    |
| `GET /api/invites/:code`                                      | Signed in; possession of a valid invite           |
| `POST /api/invites/:code/join`                                | Signed in; possession of a valid invite           |
| `POST /api/realtime-token`                                    | VIEWER in the requested project                   |
| `GET /api/projects/:projectId/items`                          | VIEWER                                            |
| `POST /api/projects/:projectId/items`                         | EDITOR                                            |
| `GET /api/projects/:projectId/items/:itemId`                  | VIEWER                                            |
| `PATCH`, `DELETE /api/projects/:projectId/items/:itemId`      | EDITOR                                            |
| `POST /api/projects/:projectId/items/:itemId/images`          | EDITOR; PAGE only                                 |
| `GET /api/projects/:projectId/items/:itemId/images/:imageKey` | VIEWER; PAGE only                                 |

Invite links expire after 1 to 30 days and can be used by multiple signed-in
people. Joining is idempotent, including concurrent requests, and preserves an
existing membership's role. Invite creation is owner-only; owners cannot be
granted through invitation links. Errors are structured `{ code, message }`
responses: 400 for invalid input, 401 for no valid session, 403 for denied
permissions or origins, 404 for missing invites, and 410 for expired invites.

Next.js 16 names middleware `proxy.ts`. It protects the project routes with an
actual session lookup; layouts and project data helpers independently enforce
authentication and permissions. Invite return paths survive sign-in and signup.

Realtime tokens use HS256, a five-minute lifetime, fixed issuer/audience, and
server-derived session, project and role claims. Hocuspocus and Socket.IO verify
the signature and recheck the live session and database membership for each
resource action. Yjs document names must identify a page or code file in that
project. Viewer updates are refused by the server, even when a client deliberately sends them.
Awareness identities are stamped by the server, and cursor relative positions
are validated before broadcasting. Session expiry, membership
revocation and role changes are rechecked during active communication.

Yjs updates are serialized per document before applying the merged size check.
Full Yjs state is saved to `Item.yjsState`, normally after a one-second debounce,
with a five-second maximum delay and a save on last disconnect. Realtime shutdown
flushes pending stores. Changes not yet saved can be lost in an abrupt process or
machine failure; a browser's sync indicator acknowledges the realtime server,
not an fsync to PostgreSQL.

## Phase 1 manual acceptance checklist

Use two independent browser sessions: account A in a normal window and account B
in a private window.

- [ ] While signed out, open `/projects` and a project URL. Both redirect to login.
- [ ] Create account A using email/password. Create a project from the dialog.
      Its list entry and room show OWNER, its name, sidebar, center, members, and chat panel.
- [ ] Rename the project. The room and project list show the updated name.
- [ ] As A, create a VIEWER invitation and copy its link.
- [ ] Open that link in the private window. Sign up as account B and confirm the
      invitation remains the return destination. Join, then find the project in B's list.
- [ ] B can open the room and see members, but cannot see Rename or Invite members.
- [ ] In B's browser console, replace PROJECT_ID below with the ID in the room URL.
      Both write requests return status 403; the project name stays unchanged.

```javascript
const projectId = "PROJECT_ID";
await fetch(`/api/projects/${projectId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Viewer must not write" }),
}).then(async (response) => ({
  status: response.status,
  body: await response.json(),
}));
await fetch(`/api/projects/${projectId}/invites`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ role: "EDITOR", expiresInDays: 7 }),
}).then(async (response) => ({
  status: response.status,
  body: await response.json(),
}));
```

- [ ] B cannot open an unrelated project by changing the URL.
- [ ] Optional account C: join an EDITOR link, rename successfully, and confirm
      creating invitations returns 403.
- [ ] Open a malformed or expired invite. It displays a useful error.
      The automated smoke script verifies expiry without waiting for real time.
- [ ] Toggle offline in browser developer tools. The connection banner appears;
      project creation, writes, joining, and auth actions are disabled. Reconnect.
- [ ] Sign out. Protected pages redirect to login; sign back in successfully.
- [ ] If OAuth credentials were configured, test Google and GitHub sign-in and
      an invitation return path with each provider.
- [ ] `pnpm.cmd test:phase1` passes while the app is running.

## Phase 3 manual acceptance checklist

Use three independent browser sessions with an OWNER and two EDITOR members in
the same project. Add a fourth VIEWER session to verify read-only access.

- [ ] Create a page and open it in all sessions. Each shows the connected users.
- [ ] Type simultaneously in all three editors, including at the same paragraph.
      Every session converges and retains all text without a refresh.
- [ ] Create, rename, nest, reorder and delete pages/folders. All sidebars update
      without reloading. Deleting a folder removes its entire subtree everywhere.
- [ ] Use the slash menu to add headings, lists, a checklist, a code block and a
      table. Formatting and edits appear in the other sessions.
- [ ] With S3 configured, upload an image. It appears in all sessions, still loads
      after reload, and its URL denies a signed-out user or unrelated member.
- [ ] The VIEWER receives changes, cannot type or manage the tree, and direct
      tree writes return 403. Automated checks also try unauthorized Yjs writes.
- [ ] Take one editor offline, make an edit, then reconnect. The warning clears
      after sync and its changes merge with edits made by the other sessions.
      Try navigating away with unsynced edits; a confirmation appears.
- [ ] Wait for persistence, close the pages, restart realtime, and reopen them.
      Text and blocks survive the new process.
- [ ] All four Phase 3 test commands below pass.

With web and realtime running:

```powershell
pnpm.cmd test:phase3
pnpm.cmd test:phase3:browser
```

After stopping the dev apps with Ctrl+C, build and run the isolated persistence
and storage checks. PostgreSQL must stay running. Ports 3002 and 3003 must be free:

```powershell
pnpm.cmd build
pnpm.cmd test:phase3:restart
pnpm.cmd test:phase3:storage
```

The restart check starts compiled realtime processes on port 3003 and recovers
saved document state with fresh clients after process replacement. On Windows,
termination is forced after confirmed persistence; it does not prove OS SIGTERM
delivery. The storage check starts a production web process on port 3002 and a
local fixture on a random port with temporary credentials. It leaves `.env`
unchanged. Both clean up their own records and processes.

## Phase 4 presence and cursors

The project sidebar's **Online now** list includes members on every page and the
project overview. Each person appears once, with links to all pages open in their
tabs. Following a location link honors the existing unsynced-edit navigation
confirmation. Page titles follow tree changes, and deleted pages lose their
location. The separate Members list continues to show all project memberships.

Socket.IO validates the project and page before accepting a presence update.
Names, colors and images come from the authenticated database account; clients
cannot supply an identity or view another project's presence. Viewers can share
their own location. Every outgoing presence snapshot rechecks live access, and a
three-second audit removes idle expired sessions and revoked memberships.
Presence is temporary process memory; no migration is required. Horizontal
presence across multiple realtime instances remains part of the deployment phase.

BlockNote's Yjs awareness renders remote cursors and selections, with name labels
always visible while a cursor is present. Tab closure removes its awareness and
project presence immediately on server disconnect; real browser checks enforce a
five-second bound. Socket.IO's two-second ping interval and three-second timeout
also detect silent connection loss. The Hocuspocus transport retains its existing
heartbeat, so silent network failure can clear page cursors more slowly than an
ordinary tab closure. Phase 5 adds the same verified identity labels and colors
to Monaco cursors and selections.

Run the apps from the workspace root in one PowerShell terminal:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd dev
```

With PostgreSQL running, use a second terminal from the same root:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd test:phase4
pnpm.cmd test:phase4:browser
```

These commands extend the existing Phase 3 suites with presence checks, keeping
the collaboration, permission, tree and offline-merge regression coverage. The
browser command uses four isolated accounts and an additional tab for the owner.
It checks actual keyboard cursor movement, verified cursor color, live page
navigation/renaming, overview locations, multiple-tab grouping, and removal of a
closed tab's cursor, page avatar and online entry within five seconds. Integration
checks additionally cover forged identities, invalid/foreign locations, deleted
pages, reconnects, idle session expiry and idle membership revocation. All
temporary identities and projects are cleaned up with the existing guards.

Manual acceptance, using an owner, editor and viewer in independent sessions:

- [ ] Open the same page. Each sidebar shows three online members and their
      current page; the page header shows three avatars.
- [ ] Type, move the caret and select text as the owner and editor. The other
      sessions show colored remote cursors/selections with their real names.
- [ ] Open another page as the editor. Everyone's online list follows the new
      page, while the old page's avatar stack loses that editor.
- [ ] Rename the second page. Its online location link updates without reload.
- [ ] Open the project overview as the viewer. Their location changes to
      Project overview; following a teammate's location opens that page.
- [ ] Open two different pages in two tabs as one user. They appear once with
      both page links. Close one tab; only that link disappears.
- [ ] Close a user's last tab. Their cursor, page avatar and online entry
      disappear from peers within five seconds.
- [ ] Disconnect and reconnect a session. The offline state hides stale presence
      and the online list recovers while edits still merge.
- [ ] Both Phase 4 test commands pass.

## Phase 5 collaborative code editor

Create a **Code file** from the sidebar's Add dialog, select its language, and
open it like a page. Monaco loads through `next/dynamic` with SSR disabled. Its
`y-monaco` binding shares `document.getText("code")` on the existing authenticated
`item:<itemId>` Hocuspocus document. Code files use the same PostgreSQL binary
Yjs persistence, offline merge, unsynced navigation guard, and current membership
checks as pages. Viewers receive edits and cursors but cannot modify code,
language, or the project tree. Server validation covers Monaco's awareness
`selection` relative positions as well as BlockNote's `cursor` positions.

The language picker uses Monaco's registered language IDs. Changes require
EDITOR access, persist on `Item.language`, and reach peers through existing
Socket.IO tree notifications. Theme and font size (10–28 px) are personal browser
preferences that survive reload. Standard input is a local tab draft, capped at
16 KiB. This phase adds the input only; execution belongs to Phase 6.

Monaco and its module workers are bundled on the application's own origin.
Monaco 0.57 changed its public export paths; a Turbopack alias and TypeScript
paths adapt the legacy editor import used by `y-monaco` and the React wrapper.
No CDN or AMD loader is required. The existing `CODE`, `language`, and `yjsState`
database fields cover this phase without a migration.

With PostgreSQL, web and realtime running:

```powershell
pnpm.cmd test:phase5
pnpm.cmd test:phase5:browser
pnpm.cmd test:phase5:restart
```

The integration and browser commands include the earlier page and presence
regression coverage. The restart command starts isolated compiled realtime
processes on port 3003 and verifies a code file survives process replacement;
that port must be free. Temporary test identities, projects, and processes are
cleaned up with the existing guards.

Manual acceptance, using an owner, editor and viewer in independent sessions:

- [ ] Create a code file from the Add dialog and open it in all sessions.
- [ ] Type simultaneously as owner and editor. Code converges with no lost text.
- [ ] Move and select with the keyboard. Peers see named, colored cursors and
      selections; closing a tab removes its cursor and online entry.
- [ ] Change the language. Every picker and Monaco syntax mode updates; reload
      retains the language.
- [ ] The viewer receives updates but cannot type, change language, or manage
      files. Direct unauthorized HTTP and Yjs writes are rejected.
- [ ] Change theme and font size. They apply locally and survive reload; stdin
      stays in the current tab.
- [ ] Edit offline while another member edits online. Reconnect and verify both
      edits merge. Navigating with unsynced edits displays the existing guard.
- [ ] Run all three Phase 5 checks. Phase 6 requires the next instruction.

## Phase 6 code execution

Code files have a **Run** button for editors and owners, shared stdout/stderr,
compiler diagnostics, exit code, runtime, and paginated history. Viewers can
read the output and history. Execution currently supports Python, JavaScript,
C++ and Java; other Monaco languages remain available for editing. Run captures
the current synced source and the local stdin draft. Code and stdin are stored
with the run on the server, but are not exposed in history responses.

`POST /api/run` validates membership, session, item type, the stored language,
the request origin, and strict shared schemas. Code is capped at 64 KiB and stdin
at 16 KiB of UTF-8. Only this route accepts a larger JSON body (512 KiB, allowing
escaped source); existing mutations keep their 16 KiB limit. The project lock
rechecks current authorization and language before saving a run.

The official Redis client runs an atomic Lua script: six accepted runs per user
and twenty per project in a sixty-second window. A sixty-five-second per-file
lease prevents overlapping runs; a matching nonce releases it on completion.
Rate limits return 429 with Retry-After, and occupied files return 409. A missing
or unreachable rate limiter returns 503 before source is submitted.

Judge0 receives Base64 source and stdin with fixed limits: 2 CPU seconds plus
0.5 seconds grace, 5 wall seconds, 256000 KiB memory, 64000 KiB stack, 60 processes
or threads, and 64 KiB files. Network access is disabled in both the submission
and the server policy. Callbacks, archives, custom flags, and command arguments
are disabled. Only server configuration chooses the endpoint and API token.
Remote endpoints require HTTPS; HTTP is allowed only on loopback. Redirects and
oversized or malformed service responses are rejected. Displayed streams are
capped at 16 KiB each and rendered as React text, including HTML-looking output.

The web request polls Judge0 for at most thirty seconds and saves the result
before returning. `run:started` and `run:finished` carry validated identifiers;
the realtime server loads their scope from PostgreSQL and rechecks each
recipient's live session and membership. Browsers refetch authorized history
on events, reconnect/focus, and every 2.5 seconds. Missed notifications therefore
recover. A history read reconciles runs interrupted for over sixty-five seconds
using the saved Judge0 token, without resubmitting source. If the token/result
cannot be recovered, the row is marked failed. Output becomes available after
execution finishes; Judge0 CE's REST API does not provide incremental stdout
streaming. An application-side service deadline does not cancel a queued Judge0
submission; its eventual execution remains subject to the sandbox limits.

### Configure and run

Use a Linux Docker host with Judge0-compatible cgroup v1 support. Judge0 1.13.1
uses privileged containers; use a dedicated execution host for deployment.
The optional `runner` Compose profile puts Judge0, its workers, and its separate
database/Redis on an internal network. Only its authenticated API is published,
on loopback. The runner never receives the application database credentials.
The default `infra:up` continues to start only the application's PostgreSQL and Redis.

Add these entries to the existing root `.env`, retaining all existing auth secrets
and database settings. Generate three independent values with
`node -p "require('node:crypto').randomBytes(32).toString('hex')"`:

```dotenv
JUDGE0_URL=http://127.0.0.1:2358
JUDGE0_AUTH_TOKEN=<first generated value>
JUDGE0_POSTGRES_PASSWORD=<second generated value>
JUDGE0_REDIS_PASSWORD=<third generated value>
JUDGE0_PORT=2358
REDIS_URL=redis://127.0.0.1:6379
```

Do not change the container host's boot/cgroup configuration from these scripts.
Check the [Judge0 release deployment instructions](https://github.com/judge0/judge0/releases/tag/v1.13.1)
and [cgroup compatibility issue](https://github.com/judge0/judge0/issues/543)
when choosing a host. A container reporting healthy only proves API readiness;
the real sandbox check below verifies its workers and language runtimes.

From the checkout root, with Docker available:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd install --frozen-lockfile --store-dir .tools/pnpm-store
pnpm.cmd infra:up
pnpm.cmd runner:up
pnpm.cmd db:migrate:deploy
pnpm.cmd build
pnpm.cmd test:phase6:sandbox
pnpm.cmd dev
```

If using the portable PostgreSQL instance, keep it running and start only the
application Redis service with
`docker compose --env-file .env -f infra/docker-compose.yml up -d --wait redis`
instead of `infra:up`. For a separate execution host, set JUDGE0_URL to its
private HTTPS origin and configure that host's authenticated runner independently.
`pnpm.cmd runner:down` stops the optional runner without removing its database.

Application integration can be checked here without Docker, after a production
build and the database migration:

```powershell
pnpm.cmd test:phase6
pnpm.cmd test:phase6:browser
```

These tests start isolated production web/realtime processes and local Judge0
and RESP2 fixtures on unused ports. Fixtures return predetermined protocol
responses; they execute no code. They verify the actual HTTP routes, official
Redis client, limits sent to Judge0, concurrent-run guards, all-role event and
history consistency, error handling, output caps, recovery, and scoped cleanup.
The browser command includes Phase 3/4/5 acceptance and checks the Run UI,
shared output/history, reload recovery, and HTML rendered as plain text.
Fixture results do not prove sandbox execution, Linux isolation, or Redis Lua
execution. `test:phase6:sandbox` requires real Judge0 and Redis, runs actual
Python/JavaScript/C++/Java programs and infinite loops, verifies compiler/runtime
errors and throttling, and repeats the browser acceptance.

Manual acceptance with an owner, editor and viewer:

- [ ] All sessions open the same Python file. Enter `print(input())`, add stdin,
      and click Run. Each session sees matching stdout, exit code and runtime.
- [ ] Repeat with JavaScript, C++ and Java; Java's public entry class is Main.
- [ ] Run `while True: pass` in Python. Judge0 reports Time Limit Exceeded.
- [ ] Submit a compile error and a runtime exception. Compiler/stderr output
      appears in red and remains in history after reloading.
- [ ] While one run is pending, another editor cannot start an overlapping run.
      After six accepted runs in one minute, a user's next run returns 429.
- [ ] The viewer sees output/history and has no Run button. Direct viewer POST,
      foreign project/history, forged socket events and cross-origin writes fail.
- [ ] Disconnect a collaborator and reconnect. History restores shared output.
      Stop Redis and confirm new runs fail with 503 before contacting Judge0.
- [ ] `pnpm.cmd test:phase6:sandbox` passes on the configured Docker host.

Phase 6's real sandbox Done when check is pending in this workspace. The user
explicitly chose to keep that verification pending and proceed with Phase 7.

## Phase 7: project chat

Each project's Team chat panel shares the existing authenticated Socket.IO
connection with the sidebar and presence. Owners and editors can send; viewers
can read history and receive live messages and typing indicators. Messages render
as plain text, including HTML and URLs, and consecutive messages from the same
author within five minutes share an author/time header. Enter sends; Shift + Enter
adds a line break. The panel can be collapsed; its badge counts newer messages
from other people while collapsed, in a background tab, or scrolled away from the
bottom. Reading the latest messages clears the badge. Unread state is per mounted
panel and resets on navigation/reload; it is not a server-side read receipt.

`chat:send` accepts only the project ID, a client-generated UUID, and a trimmed
message of 1–2000 characters (at most 8 KiB). The server derives the author from
the signed token, rechecks the current session and editor membership inside a
transaction, saves the ChatMessage, and broadcasts `chat:message` only to currently
authorized subscribers of `project:<projectId>`. A database uniqueness constraint
on author/message UUID makes retries idempotent across realtime process restarts;
reusing a UUID with different text or another project is rejected. The acknowledgement
returns the saved message. The composer retains its draft and UUID after an
unconfirmed send, so Retry send can confirm the same message safely.

`GET /api/projects/:projectId/chat` returns the newest 50 messages and an older
cursor. Pagination orders by `(createdAt, id)` and scopes cursors to the project;
all reads check current viewer membership before returning data. Reconnects reload
history, and a 15-second history refresh recovers a missed broadcast. Live events
appear immediately without waiting for this refresh. History and live messages
are deduplicated by their persisted IDs. When a long disconnect misses more than
50 messages, use Load older messages to retrieve the rest; unread counts reflect
the history currently loaded. Offline drafts remain editable, while Send is
disabled until the authenticated socket reconnects. A full page reload does not
persist unsent drafts.

`chat:typing` accepts a project and boolean, checks editor membership, and broadcasts
server-derived identities. Multiple tabs of one person produce one indicator.
Indicators expire within five seconds and are removed on blur, send, disconnect,
or loss of permission. Neither chat nor typing can target another project's room.
Sending queues are bounded per socket. Phase 8 adds persistent Redis throttling;
Phase 7 itself added no libraries or configuration secrets.

From the checkout root, with the existing PostgreSQL database running:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd db:migrate:deploy
pnpm.cmd build
pnpm.cmd test:phase7
pnpm.cmd test:phase7:browser
pnpm.cmd dev
```

The smoke tests start isolated production web/realtime processes on unused local
ports, create temporary accounts/projects, and delete only those generated
fixtures. They require the production web build and PostgreSQL, and provide a
local Redis protocol fixture. The Phase 7 fixture permits history-test bursts;
Phase 8 separately checks the actual quotas. Production chat requires Redis.
The browser suite uses isolated native Chrome
profiles and includes the Phase 3/4/5 acceptance checks. Phase 6 fixture checks
remain available separately with `pnpm.cmd test:phase6`; actual sandbox checks
remain pending.

Manual Phase 7 acceptance:

- [ ] Open one project as an owner, editor and viewer. Owner/editor messages
      appear in all three sessions in under a second. The viewer has no composer.
- [ ] Type without sending; the other sessions show your name typing. Blur the
      composer or stop typing and confirm the indicator disappears.
- [ ] Collapse the viewer's chat, send another message, and confirm the unread
      badge. Expand chat and read the latest message to clear it.
- [ ] Send two consecutive messages as one author; check their shared header.
      Enter sends and Shift + Enter keeps a new line in the draft.
- [ ] Reload or join late and see saved messages. After more than 50 messages,
      Load older messages retrieves the rest without duplicates.
- [ ] Go offline with a draft. Send from another session, reconnect, and confirm
      the draft and missed message are both present. Retry an unconfirmed send
      and confirm there is only one saved message.
- [ ] Send `<script>alert(1)</script>` and confirm it appears as text.
      Viewer/foreign project sends and revoked memberships are rejected.

On October 8, 2026, Phase 7 passed a production build, strict type checking,
lint, formatting, database migration checks, PostgreSQL/Socket.IO integration,
and four-session native Chrome acceptance. Measured authenticated message
delivery to owner/editor/viewer sessions was 61–119 ms. Late joins, reconnects,
50-message pages and equal-timestamp cursors, trusted typing expiry, viewer
restrictions, role changes, revocation, and retry deduplication across realtime
process replacement all passed. Browser checks also covered unread badges,
grouping, older history, retained offline drafts and HTML rendered as text,
with zero runtime errors, console errors or warnings. The browser suite repeated
the Phase 3/4/5 editor acceptance; Phase 6 application integration against its
local protocol fixtures also passed with the Phase 7 build. Real Phase 6
sandbox verification remains pending. Temporary test data was removed and the
existing local `.env` was retained.

## Phase 8: hardening and polish

Redis now applies fixed one-minute limits before chat or invite writes. Chat
allows 30 new messages per user and 120 per project; invitation creation allows
10 per user and 20 per project. Join attempts allow 10 per user, with a separate
60-new-members-per-project limit. Invitation preview allows 60 per user. The
existing run limits remain six per user and 20 per project per minute, plus a
single active run per file. Redis Lua checks every scope before incrementing
any counter and sets an expiry on every new key. HTTP rejections include
`Retry-After`; socket acknowledgements include retry seconds and retain the
composer draft. A retry of an already saved chat UUID consumes no new allowance.
Redis failures reject these actions before saving anything.

Chat remains escaped text. BlockNote links accept only HTTP, HTTPS, mailto, and
root-relative URLs; credentials, control characters, script/data URLs and
protocol-relative URLs are rejected. Editor image URLs must reference that
page's authenticated image route. Uploads retain the 8 MiB file limit, streamed
request limit and PNG/JPEG/GIF/WebP signature checks. SVG uploads are rejected.
HTML responses use a fresh script nonce and a Content Security Policy that
blocks inline scripts, remote frames and untrusted connections. Development
permits `unsafe-eval` for Next.js; production does not. Inline styles remain
allowed for BlockNote and Monaco. Security headers disable MIME sniffing and
framing.

The workspace shows an offline banner and an online reconnect notice. Page/code
edits remain in the open tab's Yjs document and merge after reconnection; chat
reloads history. Keep the tab open while offline: a reload before synchronization
can discard unsaved local edits. API logs are JSON with a request UUID, status,
duration and an allowed event/code. They omit request bodies, secrets, user
details and raw exceptions. Realtime startup, notifications, chat failures and
document-save failures also have structured logs.

Optional Sentry settings are documented in `.env.example`: `SENTRY_DSN` enables
web/realtime server capture; `NEXT_PUBLIC_SENTRY_DSN` enables browser capture.
Set `SENTRY_ENVIRONMENT` for the server environment. Browser DSNs are public;
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` are server/build settings
for source-map uploads. Set the public DSN before building. Blank DSNs disable
capture. Data collection, tracing, breadcrumbs and SDK logs are disabled; a final
event allowlist removes request/user/context data and private exception text,
retaining generic error types and stack locations. The transport test uses the
actual SDK with an in-memory transport and sends nothing externally. Delivery
to a real Sentry project requires configured DSNs.

Run from the root after stopping production apps for a build:

```powershell
$env:Path = (Join-Path $PWD '.tools\node_modules\.bin') + ';' + $env:Path
pnpm.cmd build
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd format:check
pnpm.cmd test:monitoring
pnpm.cmd test:phase8:fixtures
```

The local fixture command uses installed Chrome on Windows. On other systems,
install Playwright's browser once with
`pnpm --filter @collab/web exec playwright install --with-deps chromium`.
For real Redis verification, configure `REDIS_URL`, start Redis (for example
`pnpm.cmd infra:up` on a Docker host), then run `pnpm.cmd test:phase8`.
Both commands start isolated production servers on unused ports and delete
only their generated accounts/projects and Redis keys. The fixture command
models Redis protocol responses and outage behavior; it does not execute Lua.
The real command verifies the actual Lua scripts, expiry, project quotas and
concurrent admission, then runs the same two-context Playwright test.

`.github/workflows/ci.yml` installs the pinned toolchain, starts PostgreSQL and
Redis service containers, creates ephemeral CI secrets, applies migrations,
builds, checks lint/types/formatting, verifies Sentry scrubbing, runs the Phase
3 storage and Phase 6/7 regressions, and runs Phase 8 with real Redis and
Chromium. Failed browser runs upload a report for seven days. It never connects
to a real sandbox, storage bucket or Sentry project. This workspace has no Git
repository or remote, so a hosted CI run cannot be recorded here.

Manual Phase 8 acceptance:

- [ ] Use two independent browser sessions as owner/editor. Type concurrently
      into a page and confirm both see the same text.
- [ ] Take one session offline halfway through editing; type in both sessions,
      reconnect, wait for All changes synced, then reload. Both edits remain.
- [ ] Change the editor to VIEWER and reload. Page/code inputs and chat writes
      are disabled; API/socket write attempts are denied and chat still arrives.
- [ ] Send chat containing HTML; it appears as text. Paste an unsafe link or
      attempt an SVG, spoofed PNG or oversized upload; it is rejected.
- [ ] Exhaust a chat/invite allowance and see a retry time with no extra row.
      Stop Redis and confirm sends/invites fail while existing documents/history
      remain readable. Restore Redis and retry.
- [ ] Run `pnpm.cmd test:phase8` and verify the two-context test passes in the
      repository's CI workflow after the project is hosted in Git.
- [ ] Configure a Sentry project, trigger a controlled application error and
      confirm delivery includes generic error/stack data and excludes private
      content. Run `pnpm.cmd test:monitoring` to repeat the local scrubbing check.

Phase 9 has not started. Phase 6 real sandbox acceptance remains pending at the
user's request. Phase 8's hosted CI and real Redis checks remain pending locally.

On October 8, 2026, the Phase 8 production build, lint, formatting and strict
type checks passed. The local Phase 8 API/Socket.IO suite passed with Redis
protocol fixtures: chat/create/join/preview allowances, expiry, project scoping,
concurrent admission, retry deduplication, outage rejection, upload limits,
unsafe links and security headers. The two-context Playwright test passed:
concurrent text and offline/online edits converged, synchronized edits survived
reload, offline chat drafts and missed messages recovered, unsafe pasted links
were removed, viewer writes failed and chat remained readable. The actual Sentry
SDK transport test passed with private event data removed and the configured
environment retained. Phase 6 protocol-fixture regressions and the private image
storage fixture suite passed. The four-session Phase 7 browser suite also passed
the Phase 3/4/5 editor and presence regressions, including Monaco, with zero
runtime errors, console errors or warnings. Its chat reconnect test now waits
for Send to become enabled before pressing Enter; refreshed history alone does
not prove the socket has reconnected. Hosted CI, real Redis Lua execution and
delivery to a configured Sentry project remain unverified. These local passes
do not complete Phase 8's hosted-CI Done when requirement.

## Code and database verification

With app processes stopped for the production build:

```powershell
pnpm.cmd lint
pnpm.cmd typecheck
pnpm.cmd format:check
pnpm.cmd build
pnpm.cmd db:status
pnpm.cmd db:verify
```

The migrations are `20261006072601_init`, `20261008060000_code_runs`, and
`20261008070000_project_chat`.
Phases 1, 3, 4 and 5 needed no schema change; Phase 6 extends Run with status,
source snapshots, sandbox tokens, compiler output and completion metadata.
Phase 7 adds the nullable ChatMessage client UUID and its uniqueness constraint;
existing message rows remain valid.
Prisma uses `packages/db/prisma.config.ts`, its `prisma-client` generator,
and the PostgreSQL driver adapter. `pnpm.cmd db:migrate --name descriptive_name`
creates a migration for a future schema change; `db:migrate:deploy` applies
checked-in migrations.

The schema contains ten models: User, Session, Account, Verification, Project,
ProjectMember, Item, ChatMessage, Run, and Invite. The document's count of eight is
a counting error. Better Auth's four core models came from its CLI-generated
snapshot; application relations extend them.

Phase 1 HTTP integration and server permissions passed in development and
production against PostgreSQL. Phase 0 migrations, ten-model queries, Studio
access and liveness passed previously. Phase 3 scripts cover tree transactions,
live broadcasts, scoped authorization, viewer attack attempts, token forgery,
active revocation, Yjs convergence, trusted awareness and persistence. The browser
script checks actual BlockNote typing in three concurrent editor sessions, viewer
controls, four sidebars, slash headings/tables, offline edit merging and reload
recovery. Eight malformed cursor cases are rejected before reaching peers, while
valid generated cursors and real BlockNote selections still propagate. Docker/Redis
startup remains unverified because Docker is absent. Browser and Computer Use
plugin setup fails with a missing `sandboxPolicy` field; native isolated Chrome
was used for browser verification.

Final local checks passed: production build, strict type checking, lint,
formatting, the native Phase 3 integration suite, the four-session browser suite
with zero console errors/warnings, persistence across compiled-process restarts,
and production image-route tests against the isolated S3 fixture. The Phase 3
Done when criteria were verified in real browsers. Phase 4 additionally passed
its integration suite and isolated browser acceptance checks against the
production apps, including cursor movement/color and five-second tab-close
cleanup. Phase 5's integration, browser and restart suites also passed: Add
dialog creation, concurrent Monaco typing, shared language updates, named cursor
movement/color, viewer controls and server enforcement, personal settings, local
stdin, offline merge, reload recovery, and code persistence across process
replacement. The browser suite recorded zero runtime errors, console errors or
warnings. It also caught an awareness ownership cleanup gap; server disconnects
now explicitly remove the verified client's state, including after reconnects.
On October 8, 2026, a fresh production build, lint, formatting, type checks,
database status/table checks, Phase 1 HTTP checks, Phase 5 integration/browser
checks (including Phases 3/4), page/code process restarts, and the private-image
storage suite all passed before Phase 6 implementation began.

Phase 6 subsequently passed production build, strict type checking, lint,
formatting, migration status, application integration against the Judge0/RESP2
fixtures, and isolated browser acceptance with the Phase 3/4/5 regressions.
Browser checks recorded zero runtime errors, console errors or warnings. Code
process-restart persistence also passed with the Phase 6 realtime build. Actual
sandbox execution, its Linux isolation, and real Redis Lua execution remain
unverified here. The local root `.env` was retained; no sandbox credentials were
invented or real user source submitted to an external service.

## Version choices and official references

Versions are pinned in manifests and the lockfile: Next.js 16.3.8, React 19.3.0,
Tailwind 4.3.3, Prisma 7.10.0, Zod 4.6.5, Better Auth 1.7.7, Turbo 2.11.7,
pnpm 12.9.1, PostgreSQL 18.6, Redis 8.10.2, BlockNote 0.55.0, Hocuspocus 4.7.0,
Yjs 13.6.33, y-protocols 1.0.7, y-prosemirror 1.3.7, Socket.IO 4.8.4,
Monaco 0.57.0, @monaco-editor/react 4.7.0, and y-monaco 0.1.6.
Phase 6 adds the official redis 6.3.0 client and Judge0 CE 1.13.1, with a
separate PostgreSQL 16.14 runner database.
Phase 8 adds the official Sentry Next.js/Node SDKs 11.5.0 and Playwright 1.64.0,
both explicitly named in the plan.

Compatibility choices from Phase 0: Prisma's latest tag points to an 8.0 release
candidate, so stable 7.10.0 is used. Official lint peers support ESLint 9 and
TypeScript below 6.1, so TypeScript 6.0.3 and ESLint 9.39.5 are pinned. pnpm 12
uses `allowBuilds`. shadcn/ui uses its manual setup and local components; Phase 1
dialogs use the native modal dialog element without introducing another library.

API compatibility adjustments checked against official docs and installed source:
Hocuspocus 4.7 puts `readOnly` on `connectionConfig` in authentication hooks;
its docs still show the older `connection` property in places. BlockNote 0.55's
default heading prop typing needs a narrow View-prop adapter under
`exactOptionalPropertyTypes`; runtime block schemas and strict TypeScript remain
unchanged. Native Node TypeScript uses `.ts` source imports with TypeScript's
extension rewriting for runnable compiled realtime output.

- [Better Auth Next.js integration](https://better-auth.com/docs/integrations/next)
- [Better Auth Prisma adapter](https://better-auth.com/docs/adapters/prisma)
- [Better Auth email/password](https://better-auth.com/docs/authentication/email-password)
- [Better Auth Google provider](https://better-auth.com/docs/authentication/google)
- [Better Auth GitHub provider](https://better-auth.com/docs/authentication/github)
- [Better Auth session management](https://better-auth.com/docs/concepts/session-management)
- [Better Auth rate limiting](https://better-auth.com/docs/concepts/rate-limit)
- [Next.js proxy convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Node loadEnvFile](https://nodejs.org/docs/latest-v24.x/api/process.html#processloadenvfilepath)
- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [shadcn/ui manual installation](https://ui.shadcn.com/docs/installation/manual)
- [Prisma 7 guide](https://www.prisma.io/docs/orm/upgrade-guides/upgrading-versions/upgrading-to-prisma-7)
- [pnpm build settings](https://pnpm.io/settings/build)
- [PostgreSQL Windows distribution](https://www.enterprisedb.com/download-postgresql-binaries)
- [BlockNote collaboration](https://www.blocknotejs.org/docs/features/collaboration)
- [BlockNote shadcn setup](https://www.blocknotejs.org/docs/getting-started/shadcn)
- [BlockNote Next.js integration](https://www.blocknotejs.org/docs/getting-started/nextjs)
- [Hocuspocus hooks](https://tiptap.dev/docs/hocuspocus/server/hooks)
- [AWS S3 Signature V4](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)
- [Next.js viewport configuration](https://nextjs.org/docs/app/api-reference/functions/generate-viewport)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [Yjs awareness and presence](https://docs.yjs.dev/getting-started/adding-awareness)
- [Socket.IO disconnection detection](https://socket.io/docs/v4/how-it-works/)
- [Socket.IO delivery guarantees](https://socket.io/docs/v4/delivery-guarantees/)
- [Socket.IO acknowledgements](https://socket.io/docs/v4/emitting-events/)
- [TanStack Query infinite queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries)
- [Monaco ESM integration](https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md)
- [Monaco React local loader](https://github.com/suren-atoyan/monaco-react#loader-config)
- [Yjs Monaco binding](https://github.com/yjs/y-monaco)
- [Judge0 CE API](https://ce.judge0.com/)
- [Judge0 CE deployment](https://github.com/judge0/judge0/releases/tag/v1.13.1)
- [Judge0 server policy](https://github.com/judge0/judge0/blob/v1.13.1/judge0.conf)
- [Node Redis connection configuration](https://redis.io/docs/latest/develop/clients/nodejs/connect/)
- [Next.js Content Security Policy](https://nextjs.org/docs/app/guides/content-security-policy)
- [Playwright CI](https://playwright.dev/docs/ci-intro)
- [Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext)
- [Sentry SDK migration and data collection](https://github.com/getsentry/sentry-javascript/blob/develop/MIGRATION.md)
