# Deploying the GameForge AI Studio frontend to Vercel

**You deploy this yourself** — the agent never touches Vercel. This guide is the
complete checklist; nothing here requires the agent.

The frontend is a static Vite + React SPA (`apps/web`). It talks to the API
you will run on Oracle (see `docs/ORACLE_INSTALL.md`) — Vercel hosts only the
static files, no server code, no secrets.

## Prerequisites

- The repo pushed to GitHub (the whole `gameforge-ai-studio` monorepo).
- Your Oracle backend running and reachable at `https://YOUR_DOMAIN`
  (Caddy proxies `/api/*` to the API — see the Oracle guide).

## 1. Import the project

1. Go to https://vercel.com/new and import the GitHub repo.
2. When Vercel asks for the project settings, set:
   - **Framework Preset:** Vite
   - **Root Directory:** `apps/web`
   - **Build Command:** `npm run build`
     (this runs `tsc -p tsconfig.json && vite build` — typecheck included)
   - **Output Directory:** `dist`
   - **Install Command:** `npm install` (default is fine)
   - **Node.js Version:** 20.x or newer (repo requires `>=20`)

## 2. Environment variables

Add exactly one variable (no secrets — this value ships in the client bundle):

| Name | Value | Notes |
|---|---|---|
| `VITE_API_URL` | `https://YOUR_DOMAIN:8443` | Origin only, NO `/api` suffix and no trailing slash. The client appends `/api/v1/...` itself (`apps/web/src/api/client.ts`). |

`VITE_API_URL` is baked in **at build time**. If you change it later, redeploy
(Vercel rebuilds automatically on variable change).

> Never put `CLOUDFLARE_API_TOKEN` or any other secret in Vercel env vars for this
> project — the browser bundle must never contain secrets. The Cloudflare token lives
> only in the Oracle server's environment (see the Oracle guide).

## 3. SPA routing

`apps/web/vercel.json` already contains the rewrite every client-side route
needs:

```json
{"rewrites":[{"destination":"/index.html","source":"/(.*)"}]}
```

Leave it as is. (It rewrites all paths to `index.html` so React Router's
`/projects/:id`, `/settings`, etc. work on refresh and deep links.)

## 4. Web Analytics

`@vercel/analytics` is already a dependency and `<Analytics />` is mounted once
in `apps/web/src/App.tsx`. To start collecting data:

1. Open the project in the Vercel dashboard → **Analytics** tab.
2. Click **Enable** (Web Analytics, free tier is enough).
3. Redeploy once (or wait for the next deployment) — events start flowing.

No code changes needed.

## 5. First-load check

After the deployment finishes, open the site and verify:

1. The dashboard loads with no console errors.
2. Go to **Settings** → the **API base URL** shows your `VITE_API_URL`
   (read-only — it comes from the build).
3. If the backend is up: creating a project, opening the Studio, and the
   preview iframe all work. If the backend isn't up yet, you'll see the
   honest "Couldn't load projects. The backend may be unreachable." state —
   that message means the frontend is fine and the API isn't reachable.

## PWA notes

The build generates a service worker (`vite-plugin-pwa`, `registerType: 'prompt'`).
Updates never force-reload: the user is asked before a new version activates,
so a running agent stream is never dropped by an update mid-run.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank page | Check the browser console; usually a wrong `VITE_API_URL` is not the cause of a blank page (API failures show inline error states). Rebuild with the console open. |
| "Couldn't load projects" everywhere | `VITE_API_URL` wrong or backend down. The value is baked at build time — fix the variable and redeploy. |
| 404 on refresh of `/projects/…` | `vercel.json` rewrites missing — it ships in `apps/web/vercel.json`; make sure Root Directory is `apps/web`. |
| Analytics shows nothing | Enable it in the dashboard Analytics tab, then redeploy. |
