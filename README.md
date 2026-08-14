# Upward Investments Backend

This folder contains the Node.js/Express backend for the Upward Investments application.

## Run locally

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the example environment file and update values:
   ```bash
   cp .env.example .env.local
   ```
3. Start the server:
   ```bash
   npm start
   ```

## Notes

- The backend expects a MySQL database configured via the `DATABASE_URL` environment variable.
- Prisma migrations should be applied from this folder when the database is ready.

## Deploying to Render

This backend is self-contained inside the `backend/` folder.
When you deploy with Render, use the `render.yaml` file at the repository root.

Steps:
1. Push this repo to your Git provider.
2. Create a new Render Web Service and connect your repo.
3. Use the `render.yaml` service definition or set:
   - Root: `backend`
   - Build Command: `npm install`
   - Start Command: `npm start`
4. Add the required environment variables in Render:
   - `DATABASE_URL`
   - `SMTP_HOST`
   - `SMTP_PORT`
   - `SMTP_SECURE`
   - `SMTP_USER`
   - `SMTP_PASS`
   - `EMAIL_USER`
   - `EMAIL_PASS`
   - `EMAIL_FROM`
   - `ADMIN_EMAIL`
   - `ADMIN_PASSWORD`
   - `ADMIN_CREATION_KEY` (optional)
   - `REDIS_URL` (optional)
   - `UPSTASH_REDIS_REST_URL` (optional)
   - `UPSTASH_REDIS_REST_TOKEN` (optional)

If you want Render to run the backend from the `backend` folder, the `render.yaml` file already points to that folder.

## Auto-push backend changes to GitHub

You can run a small watcher that will automatically commit and push any changes in this folder to a target GitHub repository.

1. Install dependencies (adds `chokidar`):

```bash
cd backend
npm install
```

2. Run the watcher (defaults to pushing to `git@github.com:garpsan9090/android-backend-server.git` on branch `main`):

```bash
cd backend
npm run auto-push
```

3. Optional environment variables:

- `REMOTE_URL` — remote repository URL to push to (default: `git@github.com:garpsan9090/android-backend-server.git`).
- `REMOTE_NAME` — git remote name to use/add (default: `garpsan`).
- `BRANCH` — branch to push to (default: `main`).
- `WATCH_PATH` — path under `backend/` to watch (default: `.`).

Notes:
- The script will add a remote named as configured if it does not exist. Ensure your machine has appropriate Git credentials (SSH key or credential helper) for pushing.
- The watcher ignores `.git`, `node_modules`, `.env*`, `uploads`, and `build` directories.

