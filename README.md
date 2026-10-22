# Collab

A live collaboration workspace: teams edit Notion-style pages and code files
together, run code, and chat in shared projects.

- **Pages:** BlockNote editor, synced live with Yjs (no merge conflicts).
- **Code:** Monaco editor with shared cursors; Python, JavaScript, C++ and
  Java run in the free Paiza.io sandbox.
- **Chat, presence, sidebar:** Socket.IO.
- **Accounts and roles:** Better Auth (email, Google, GitHub); projects have
  OWNER, EDITOR and VIEWER members, checked on the server.

## How it runs

One Node process (`server.ts`) serves everything on one port:

```
Browser ──HTTP──────▶ Next.js (pages + /api routes)
        ──/yjs──────▶ Hocuspocus (live documents)
        ──/socket.io▶ Socket.IO (chat, presence, sidebar, run events)
                          │
                          ▼
                      PostgreSQL (Prisma)
```

Realtime connections use the normal session cookie and are checked once when
they open. Documents are saved to PostgreSQL a couple of seconds after edits
and when the last person leaves. Rate limits are kept in memory, so run a
single instance.

## Setup

Requires Node.js 22+ and a PostgreSQL database (for example a free
[Neon](https://neon.tech) project; pick the region closest to your users,
since every database round trip adds that distance).

```bash
npm install
cp .env.example .env        # then fill in DATABASE_URL and BETTER_AUTH_SECRET
npx prisma migrate deploy
npm run dev                 # http://127.0.0.1:3000
```

Open the app at exactly the `BETTER_AUTH_URL` origin; cookies and origin
checks depend on it.

### Optional settings (`.env`)

| Setting                                    | Purpose                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in. Callback: `<BETTER_AUTH_URL>/api/auth/callback/google`         |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub sign-in. Callback: `<BETTER_AUTH_URL>/api/auth/callback/github`         |
| `PAIZA_API_KEY`                            | Optional own key for code execution; the public `guest` key is used otherwise. |
| `PORT`, `HOST`                             | Defaults: `3000`, `127.0.0.1` (dev) / `0.0.0.0` (production).                  |

User code is only ever sent to Paiza.io; the app never executes it.

## Scripts

| Command                                                     | What it does                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                               | Start the app with hot reload.                                                                                                                                                                               |
| `npm run build` / `npm start`                               | Production build and server.                                                                                                                                                                                 |
| `npm run lint`, `npm run typecheck`, `npm run format:check` | Static checks.                                                                                                                                                                                               |
| `npm test`                                                  | Unit tests (Node's built-in test runner).                                                                                                                                                                    |
| `npm run test:e2e`                                          | Two-browser Playwright test: concurrent editing, offline merge, chat, viewer permissions. Reuses a running server, otherwise starts `npm start`. Set `PLAYWRIGHT_CHANNEL=chrome` to use an installed Chrome. |
| `npm run db:migrate`                                        | Create a migration after changing `prisma/schema.prisma`.                                                                                                                                                    |
| `npm run db:deploy`                                         | Apply migrations.                                                                                                                                                                                            |

## Deploying

Deploy as one long-running Node service (Railway, Render, Fly.io or a VPS):
`npm ci && npx prisma migrate deploy && npm run build`, then `npm start`.
Serverless hosts such as Vercel cannot keep the WebSocket connections open.
Put it behind HTTPS and set `BETTER_AUTH_URL` to the public `https://` URL.

## Project layout

```
app/          Next.js pages and API routes
components/   UI (editor, code, chat, tree, presence, workspace)
lib/          Server and client helpers; lib/shared holds Zod schemas
realtime/     Hocuspocus + Socket.IO, attached to the HTTP server
prisma/       Database schema and migrations
tests/        Playwright end-to-end test and unit tests
server.ts     Entry point
```
