# Northstar AI JobSeeker

Northstar is an approval-first job-search assistant. The current MVP includes a dashboard, persistent local JSON storage, profile data, job review and approval endpoints, application records, integration placeholders, scheduled-run records, and a Docker image suitable for Coolify.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Run the built-in validation with `npm test`.

## API

- `GET /api/health`
- `GET /api/state`
- `GET|PUT /api/profile`
- `GET /api/jobs`
- `POST /api/jobs/:id/approve`
- `POST /api/jobs/:id/dismiss`
- `GET /api/applications`
- `GET /api/integrations`
- `POST /api/integrations/:id/connect`
- `POST /api/runs`

The JSON store is intentionally simple for the prototype. Before production, replace it with PostgreSQL and add encrypted session storage, a queue worker, provider adapters, and authentication.

## Coolify

Create a Docker-based application from this repository. Coolify will use the included `Dockerfile`; expose port `3000` and configure a persistent volume mounted at `/app/data` so local state survives redeployments.

The image includes a health check at `/api/health`. Configure `PORT` only if Coolify assigns a different internal port.

The application intentionally does not store job-site passwords or submit applications without an explicit approval step.

## AI providers

Resume tailoring uses OpenAI when `OPENAI_API_KEY` is present, Gemini when `GEMINI_API_KEY` is present, and a local template when neither is configured. Set the model names with `OPENAI_MODEL` or `GEMINI_MODEL`. Keep keys in Coolify environment variables; never commit them.
