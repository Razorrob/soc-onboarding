# SOC Onboarding

Standalone customer onboarding portal for SOC T0 SaaS. This project handles customer Azure AD authentication, workspace selection/creation, and deployment of the SOC T0 integration components.

## Project Structure

```
soc-onboarding/
├── app/                          # Backend (FastAPI)
│   ├── api/v1/
│   │   ├── onboarding.py        # Onboarding API endpoints
│   │   └── router.py            # API router
│   ├── services/
│   │   └── cosmos_service.py    # Cosmos DB operations
│   ├── config.py                # Configuration
│   └── main.py                  # FastAPI application
├── portal/                       # Frontend (React + Vite)
│   ├── src/
│   │   ├── App.tsx              # Main application
│   │   ├── authConfig.ts        # MSAL configuration
│   │   └── services/api.ts      # API client
│   └── package.json
├── arm-templates/               # Azure deployment templates
├── requirements.txt             # Python dependencies
├── Dockerfile                   # Backend container
└── docker-compose.yml           # Docker orchestration
```

## Features

- Azure AD multi-tenant authentication
- List and select existing Log Analytics workspaces
- Create new workspaces with Microsoft Sentinel enabled
- Generate and manage API keys
- Deploy Logic App playbook via ARM template
- Automatically create Sentinel automation rules

## Quick Start

### Backend

```bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install dependencies
pip install -r requirements.txt

# Copy and configure environment
cp .env.example .env
# Edit .env with your Azure credentials

# Run development server
uvicorn app.main:app --reload --port 8000
```

### Frontend (Portal)

```bash
cd portal

# Install dependencies
npm install

# Run development server
npm run dev
```

### Docker

```bash
# Build and run all services
docker-compose up -d
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MULTI_TENANT_APP_CLIENT_ID` | Azure AD multi-tenant app client ID |
| `MULTI_TENANT_APP_CLIENT_SECRET` | Azure AD app client secret |
| `COSMOS_ENDPOINT` | Cosmos DB endpoint URL |
| `COSMOS_KEY` | Cosmos DB primary key |
| `COSMOS_DATABASE_NAME` | Database name (default: soc_onboarding) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/onboarding/auth-url` | Get Azure AD consent URL |
| GET | `/api/v1/onboarding/callback` | OAuth callback handler |
| GET | `/api/v1/onboarding/workspaces` | List Log Analytics workspaces |
| GET | `/api/v1/onboarding/customer-status` | Check if customer exists |
| POST | `/api/v1/onboarding/regenerate-api-key` | Regenerate API key |
| POST | `/api/v1/onboarding/complete` | Complete onboarding |
| GET | `/api/v1/onboarding/deploy-url` | Get ARM template deploy URL |
| POST | `/api/v1/onboarding/create-workspace` | Create new workspace |
| POST | `/api/v1/onboarding/create-automation-rule` | Create Sentinel automation rule |

## Onboarding Flow

1. Customer clicks "Connect with Azure AD"
2. Azure AD admin consent grants permissions
3. Customer selects or creates a Sentinel workspace
4. API key is generated and displayed (save it!)
5. Customer deploys ARM template to their Azure
6. Automation rule is created to trigger on incidents
