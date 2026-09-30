# Northstar AI JobSeeker

Northstar is an approval-first job-search assistant. It discovers current remote roles, imports PDF/DOCX/text resumes, extracts profile details, generates a truthful job-specific resume, and keeps every application behind an explicit approval step. It includes persistent local storage, twice-daily searches, manual runs, dark mode, onboarding, and a Docker image suitable for Coolify.

The deployed single-user MVP includes real account creation, password-based sign-in, 30-day secure HTTP-only sessions, sign-out, session-protected APIs, and a guided three-step setup checklist. Passwords are stored as salted `scrypt` hashes, never as plain text.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

Run the built-in validation with `npm test`.

## API

- `GET /api/health`
- `GET /api/auth/session`
- `POST /api/auth/signup`
- `POST /api/auth/signin`
- `POST /api/auth/signout`
- `GET /api/state`
- `GET|PUT /api/profile`
- `GET|POST /api/resumes`
- `POST /api/resumes/:id/apply-suggestions`
- `GET /api/resumes/:id/download`
- `GET /api/jobs`
- `POST /api/jobs/:id/approve`
- `POST /api/jobs/:id/dismiss`
- `GET /api/applications`
- `POST /api/applications/:id/tailor`
- `GET /api/applications/:id/download`
- `GET /api/integrations`
- `POST /api/integrations/:id/connect`
- `POST /api/runs`

The default discovery source is Remotive's public remote-jobs API and each listing links back to its source. Set `JOB_FEED_URL` to use a compatible JSON feed instead. The JSON store is intentionally simple for this single-user MVP. Before offering the app to multiple users, replace it with PostgreSQL and add authentication, encrypted secrets, and a queue worker.

## Coolify

Create a Docker-based application from this repository. Coolify will use the included `Dockerfile`; expose port `3000` and configure a persistent volume mounted at `/app/data` so local state survives redeployments.

The image includes a health check at `/api/health`. Configure `PORT` only if Coolify assigns a different internal port.

The application intentionally does not store job-site passwords or submit applications without an explicit approval step. LinkedIn and Indeed are secure browser handoffs to their official resume-management pages. Greenhouse and Lever application submission requires employer-issued API credentials and should not be represented as a universal candidate-side integration.

Deployment is connected to Coolify through the repository push webhook. Pushes to `master` trigger a new deployment automatically.

## AI providers

Resume tailoring uses OpenAI when `OPENAI_API_KEY` is present, Gemini when `GEMINI_API_KEY` is present, and a local template when neither is configured. Set the model names with `OPENAI_MODEL` or `GEMINI_MODEL`. Keep keys in Coolify environment variables; never commit them.

Contextual “Help me write” controls use Gemini for target titles, skill lists, professional summaries, and future application-answer fields. Configure `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) in Coolify; the secret is only read by the server and is never sent to the browser. Suggestions are grounded in the confirmed profile and must be reviewed before saving.
