# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

SOC Onboarding is a standalone customer onboarding portal extracted from the SOC T0 SaaS platform. It handles Azure AD authentication, workspace selection/creation, and deployment of integration components.

## Common Commands

### Backend Development
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
pytest tests/
```

### Frontend (Portal)
```bash
cd portal
npm install
npm run dev      # Development server on port 5175
npm run build    # Production build
```

### Docker
```bash
docker-compose up -d
```

## Architecture

### Backend (FastAPI)
```
app/
├── main.py                    # Entry point with CORS
├── config.py                  # Pydantic Settings
├── api/v1/
│   ├── onboarding.py          # All onboarding endpoints
│   └── router.py              # API router
└── services/
    └── cosmos_service.py      # Customer data operations
```

### Frontend (Portal)
```
portal/
├── src/
│   ├── App.tsx                # Main onboarding wizard
│   ├── authConfig.ts          # MSAL multi-tenant config
│   ├── main.tsx               # React entry point
│   └── services/api.ts        # Backend API client
├── package.json
└── vite.config.ts
```

## Key Flow

1. Customer connects with Azure AD (multi-tenant consent)
2. Portal lists their Log Analytics workspaces
3. Customer selects workspace or creates new one
4. Backend generates API key and stores customer record
5. Customer deploys ARM template to their Azure
6. Portal auto-detects deployment and creates automation rule

## Multi-Tenant Authentication

Uses Azure AD multi-tenant app registration:
- Client ID: `c6b3223d-983e-42bb-8d0d-22ed3831aac9`
- Authority: `https://login.microsoftonline.com/organizations`
- Scopes: Azure Management API + OpenID

## Key Environment Variables

```bash
MULTI_TENANT_APP_CLIENT_ID=
MULTI_TENANT_APP_CLIENT_SECRET=
COSMOS_ENDPOINT=
COSMOS_KEY=
COSMOS_DATABASE_NAME=soc_onboarding
```
