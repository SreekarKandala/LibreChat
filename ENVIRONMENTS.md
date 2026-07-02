# Environments (dev / demo / uat)

This fork runs LibreChat as a **headless agents API** (the React frontend has been
removed). Everything LibreChat persists — agents, conversations, messages, actions,
users, balances/transactions, roles — is stored in MongoDB via `MONGO_URI`. Pointing
each environment at its own connection string gives each one fully isolated data.

## Setup

1. Copy the template for each environment you deploy:

   ```
   .env.dev.example  -> .env.dev
   .env.demo.example -> .env.demo
   .env.uat.example  -> .env.uat
   ```

2. Set `MONGO_URI` to that environment's connection string, and generate a unique
   `JWT_SECRET` / `JWT_REFRESH_SECRET` / `CREDS_KEY` / `CREDS_IV` per environment.
   Shared, non-secret settings can stay in the base `.env` — the per-env file only
   needs the values that differ (per-env values win over `.env`).

3. Start the server for an environment:

   ```
   npm run start:dev
   npm run start:demo
   npm run start:uat
   ```

   In Docker, pass the file instead: `docker compose --env-file .env.uat up -d`
   (or bake the variables into the orchestrator's environment).

## Per-environment checklist

Because each environment has its own database, per-DB state must be created in each:

- **Service account** the backend acts as (`SERVICE_USER_EMAIL`): create it once per
  database with `node --env-file=.env.uat config/create-user.js`. Login has been
  removed from this fork — the Angular client sends no credentials or tokens; every
  request runs as this user. **This makes the API open to anyone who can reach it**:
  it must not be directly exposed to the internet; restrict it to the app's
  network / reverse proxy.
- **Agents / actions** are per-database — recreate or export/import them per env.
- Tokens are signed per-`JWT_SECRET`, so tokens never carry across environments
  (the Angular client already scopes its cached token by backend URL).

## Notes

- The `x-gosure-token` header sent by the Angular client overrides the stored
  `api_key` for `service_http` agent actions (see `api/server/services/ActionService.js`),
  letting actions call the Gosure backend with the end user's own bearer token.
- Uploaded images/avatars are stored on disk under `client/public/images` (kept as a
  data directory) and served from `/images` — mount it as a volume in Docker.
