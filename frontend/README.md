# Nifty 500 Swing Scanner — Frontend

React + Vite frontend for the Nifty 500 Swing Scanner.

## Local development

```bash
npm install
npm run dev
```

By default the app calls `http://127.0.0.1:8000`. To override it, create `.env.local`:

```env
VITE_API_URL=http://127.0.0.1:8000
```

## GitHub Pages deployment

The repository is configured for:

`https://atharwaah.github.io/nifty500-swing-scanner-frontend/`

The GitHub Actions workflow builds and deploys on every push to `main`.

In GitHub repository **Settings → Secrets and variables → Actions → Variables**, create:

`VITE_API_URL` = your deployed FastAPI URL, for example `https://your-service.onrender.com`

Do not put secrets in `VITE_API_URL`; it is embedded into the public frontend build.
