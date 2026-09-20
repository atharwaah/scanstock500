# Nifty 500 Swing Scanner — Backend

FastAPI backend for the Nifty 500 Swing Scanner.

## Local development

```bash
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check:

`http://127.0.0.1:8000/api/health`

## Render deployment

Create a Render Web Service from this repository/folder.

Build command:

```bash
pip install -r requirements.txt
```

Start command:

```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Set this environment variable in Render:

```text
FRONTEND_ORIGIN=https://atharwaah.github.io
```

The backend is intentionally unchanged in scanner logic; the deployment change only makes the allowed frontend origin configurable.
