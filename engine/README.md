# MultiBot Engine

Optional Python runtime for MultiBot. It provides stateful bot profiles,
browser/computer tools, MCP integrations, approvals, routines, and engine
events behind the Node.js harness.

## Development

Requirements: Python 3.12, uv, and a local checkout of the supported Hermes
Agent runtime when required by the selected provider.

```powershell
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.venv\Scripts\python.exe -m pytest -v
```

Copy `.env.example` to `.env` and fill provider values locally. Never commit
that file or any provider credential.

## Run

```powershell
.venv\Scripts\python.exe -m uvicorn server.app:app --port 8700
```

Bot profiles and engine state stay outside the repository. Set
`MULTIBOT_ENGINE_DATA_DIR` to an operator-owned data directory; the default is
a directory below the current user's home directory.

The Node.js harness normally starts and supervises this process. Running the
engine directly is useful for local debugging only.

## Security

Keep the engine on loopback and expose the authenticated harness instead.
Computer-use sessions, browser profiles, transcripts, and provider keys are
local secrets.
