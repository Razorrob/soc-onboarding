"""Customer onboarding API endpoints."""
import os
import secrets
import hashlib
from typing import Optional
from urllib.parse import urlencode, quote
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
import httpx

from app.config import get_settings
from app.services import get_cosmos_service

router = APIRouter()

# Multi-tenant app registration (SOC T0 SaaS Integration)
MULTI_TENANT_CLIENT_ID = os.getenv("MULTI_TENANT_APP_CLIENT_ID", "c6b3223d-983e-42bb-8d0d-22ed3831aac9")
MULTI_TENANT_CLIENT_SECRET = os.getenv("MULTI_TENANT_APP_CLIENT_SECRET", "")

# In-memory state storage (use Redis in production)
_state_store: dict[str, dict] = {}


class WorkspaceInfo(BaseModel):
    subscription_id: str
    subscription_name: str
    resource_group: str
    workspace_name: str
    workspace_id: str
    location: str
    sentinel_enabled: bool = False


class OnboardingCompleteRequest(BaseModel):
    tenant_id: str
    subscription_id: str
    resource_group: str
    workspace_name: str
    workspace_id: str
    callback_url: Optional[str] = None
    ai_analysis_enabled: bool = True


class OnboardingCompleteResponse(BaseModel):
    customer_id: str
    api_key: str
    message: str


@router.get("/auth-url")
async def get_auth_url(
    redirect_uri: str = Query(..., description="URI to redirect back after auth")
):
    """Generate Azure AD admin consent URL."""
    # Generate state token
    state = secrets.token_urlsafe(32)
    _state_store[state] = {"redirect_uri": redirect_uri}

    # Build admin consent URL
    params = {
        "client_id": MULTI_TENANT_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "response_mode": "query",
        "scope": "https://management.azure.com/.default openid profile email",
        "state": state,
        "prompt": "consent"
    }

    auth_url = f"https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?{urlencode(params)}"

    return {
        "auth_url": auth_url,
        "state": state
    }


@router.get("/callback")
async def oauth_callback(
    code: str = Query(...),
    state: str = Query(...),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None)
):
    """Handle OAuth callback from Azure AD."""
    if error:
        raise HTTPException(status_code=400, detail=f"{error}: {error_description}")

    # Validate state
    if state not in _state_store:
        raise HTTPException(status_code=400, detail="Invalid state token")

    stored_state = _state_store.pop(state)
    redirect_uri = stored_state["redirect_uri"]

    # Exchange code for tokens
    token_url = "https://login.microsoftonline.com/organizations/oauth2/v2.0/token"

    async with httpx.AsyncClient() as client:
        response = await client.post(
            token_url,
            data={
                "client_id": MULTI_TENANT_CLIENT_ID,
                "client_secret": MULTI_TENANT_CLIENT_SECRET,
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "scope": "https://management.azure.com/.default openid profile email"
            }
        )

        if response.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Token exchange failed: {response.text}")

        token_data = response.json()

    # Extract tenant ID from the token
    import jwt
    id_token = token_data.get("id_token")
    if id_token:
        # Decode without verification (just to get claims)
        claims = jwt.decode(id_token, options={"verify_signature": False})
        tenant_id = claims.get("tid")
    else:
        tenant_id = None

    return {
        "access_token": token_data.get("access_token"),
        "tenant_id": tenant_id,
        "expires_in": token_data.get("expires_in")
    }


@router.get("/workspaces")
async def list_workspaces(
    access_token: str = Query(..., description="Azure access token from OAuth flow")
):
    """List Log Analytics workspaces accessible to the authenticated user."""
    workspaces: list[WorkspaceInfo] = []
    debug_info = {"subscriptions_found": 0, "workspaces_checked": 0, "errors": []}

    headers = {"Authorization": f"Bearer {access_token}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # Get subscriptions
        subs_response = await client.get(
            "https://management.azure.com/subscriptions?api-version=2022-12-01",
            headers=headers
        )

        if subs_response.status_code != 200:
            error_detail = f"Failed to list subscriptions (HTTP {subs_response.status_code}): {subs_response.text}"
            print(f"[WORKSPACES] {error_detail}")
            raise HTTPException(status_code=400, detail=error_detail)

        subscriptions = subs_response.json().get("value", [])
        debug_info["subscriptions_found"] = len(subscriptions)
        debug_info["subscription_names"] = [s.get("displayName", s["subscriptionId"]) for s in subscriptions]
        print(f"[WORKSPACES] Found {len(subscriptions)} subscriptions: {debug_info['subscription_names']}")

        # Get workspaces for each subscription
        for sub in subscriptions:
            sub_id = sub["subscriptionId"]
            sub_name = sub.get("displayName", sub_id)
            print(f"[WORKSPACES] Checking subscription: {sub_name} ({sub_id})")

            # List Log Analytics workspaces
            ws_response = await client.get(
                f"https://management.azure.com/subscriptions/{sub_id}/providers/Microsoft.OperationalInsights/workspaces?api-version=2023-09-01",
                headers=headers
            )

            if ws_response.status_code == 200:
                ws_list = ws_response.json().get("value", [])
                print(f"[WORKSPACES] Found {len(ws_list)} workspaces in {sub_name}")

                for ws in ws_list:
                    debug_info["workspaces_checked"] += 1
                    # Extract resource group from ID
                    ws_id = ws["id"]
                    parts = ws_id.split("/")
                    rg_index = parts.index("resourceGroups") + 1 if "resourceGroups" in parts else -1
                    resource_group = parts[rg_index] if rg_index > 0 else ""

                    # Check if Sentinel is enabled (check onboarding state)
                    sentinel_enabled = False
                    try:
                        # First check for SecurityInsights solution
                        sentinel_response = await client.get(
                            f"https://management.azure.com/subscriptions/{sub_id}/resourceGroups/{resource_group}/providers/Microsoft.OperationsManagement/solutions/SecurityInsights({ws['name']})?api-version=2015-11-01-preview",
                            headers=headers
                        )
                        if sentinel_response.status_code == 200:
                            # Also verify Sentinel onboarding state
                            onboard_response = await client.get(
                                f"https://management.azure.com/subscriptions/{sub_id}/resourceGroups/{resource_group}/providers/Microsoft.OperationalInsights/workspaces/{ws['name']}/providers/Microsoft.SecurityInsights/onboardingStates/default?api-version=2024-03-01",
                                headers=headers
                            )
                            sentinel_enabled = onboard_response.status_code == 200
                    except:
                        pass

                    workspaces.append(WorkspaceInfo(
                        subscription_id=sub_id,
                        subscription_name=sub_name,
                        resource_group=resource_group,
                        workspace_name=ws["name"],
                        workspace_id=ws["properties"].get("customerId", ""),
                        location=ws.get("location", ""),
                        sentinel_enabled=sentinel_enabled
                    ))
            else:
                error_msg = f"Failed to list workspaces in {sub_name}: HTTP {ws_response.status_code}"
                print(f"[WORKSPACES] {error_msg}")
                debug_info["errors"].append(error_msg)

    print(f"[WORKSPACES] Total workspaces found: {len(workspaces)}")
    return {"workspaces": workspaces, "debug": debug_info}


class CustomerStatusResponse(BaseModel):
    exists: bool
    customer_id: Optional[str] = None
    workspace_name: Optional[str] = None
    workspace_id: Optional[str] = None
    subscription_id: Optional[str] = None
    resource_group: Optional[str] = None


class RegenerateApiKeyResponse(BaseModel):
    customer_id: str
    api_key: str
    message: str


@router.get("/customer-status")
async def check_customer_status(tenant_id: str = Query(..., description="Azure AD tenant ID")):
    """Check if a customer already exists for this tenant."""
    cosmos = get_cosmos_service()
    existing = await cosmos.get_customer_by_tenant(tenant_id)

    if existing:
        return CustomerStatusResponse(
            exists=True,
            customer_id=existing.get("id"),
            workspace_name=existing.get("workspace_name"),
            workspace_id=existing.get("workspace_id"),
            subscription_id=existing.get("subscription_id"),
            resource_group=existing.get("resource_group")
        )

    return CustomerStatusResponse(exists=False)


@router.post("/regenerate-api-key", response_model=RegenerateApiKeyResponse)
async def regenerate_api_key(tenant_id: str = Query(..., description="Azure AD tenant ID")):
    """Regenerate API key for an existing customer. The old key will be invalidated."""
    cosmos = get_cosmos_service()

    # Find existing customer
    existing = await cosmos.get_customer_by_tenant(tenant_id)
    if not existing:
        raise HTTPException(
            status_code=404,
            detail="No customer found for this tenant. Please complete onboarding first."
        )

    # Generate new API key
    new_api_key = f"soc_{secrets.token_urlsafe(32)}"
    api_key_hash = hashlib.sha256(new_api_key.encode()).hexdigest()

    # Update customer record with new key hash
    await cosmos.update_customer_api_key(existing["id"], api_key_hash)

    # Log audit event
    await cosmos.log_audit_event(
        customer_id=existing["id"],
        event_type="api_key_regenerated",
        details={"tenant_id": tenant_id}
    )

    return RegenerateApiKeyResponse(
        customer_id=existing["id"],
        api_key=new_api_key,
        message="New API key generated. Save it securely - it won't be shown again! Your old key has been invalidated."
    )


@router.post("/complete", response_model=OnboardingCompleteResponse)
async def complete_onboarding(request: OnboardingCompleteRequest):
    """Complete customer onboarding - create customer record and return API key."""
    cosmos = get_cosmos_service()

    # Check if customer already exists for this tenant
    existing = await cosmos.get_customer_by_tenant(request.tenant_id)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="A customer already exists for this tenant. Contact support to manage your subscription."
        )

    # Create customer record
    customer = await cosmos.create_customer(
        tenant_id=request.tenant_id,
        workspace_id=request.workspace_id,
        workspace_name=request.workspace_name,
        subscription_id=request.subscription_id,
        resource_group=request.resource_group,
        callback_url=request.callback_url,
        ai_analysis_enabled=request.ai_analysis_enabled
    )

    # Log audit event
    await cosmos.log_audit_event(
        customer_id=customer["id"],
        event_type="customer_onboarded",
        details={
            "tenant_id": request.tenant_id,
            "workspace_name": request.workspace_name,
            "subscription_id": request.subscription_id
        }
    )

    return OnboardingCompleteResponse(
        customer_id=customer["id"],
        api_key=customer["api_key"],  # Only returned once!
        message="Customer created successfully. Save your API key - it won't be shown again!"
    )


@router.get("/deploy-url")
async def get_deploy_url(
    workspace_name: str = Query(...),
    resource_group: str = Query(...),
    api_key: str = Query(...),
    tenant_id: str = Query(..., description="Customer Azure AD tenant ID"),
    subscription_id: str = Query(None),
    location: str = Query(None)
):
    """Generate 'Deploy to Azure' URL with pre-filled parameters."""
    import json

    # Template URL (Azure Blob Storage - publicly accessible)
    template_url = "https://soct0templates.blob.core.windows.net/templates/soc-t0-complete.json"

    # Build parameters JSON for pre-filling in Azure Portal
    # Format: {"paramName": {"value": "paramValue"}}
    params_obj = {
        "workspaceName": {"value": workspace_name},
        "tenantId": {"value": tenant_id},
        "customerApiKey": {"value": api_key},
        "saasEndpoint": {"value": "https://soc-t0-saas.azurewebsites.net"}
    }

    if location:
        params_obj["location"] = {"value": location}

    # Encode template URL
    encoded_template = quote(template_url, safe="")

    # Build parameters JSON and encode it
    params_json = json.dumps(params_obj)
    encoded_params = quote(params_json, safe="")

    # Azure Portal URL format for ARM template with pre-filled parameters
    # Using the newer CustomDeploymentBlade format
    deploy_url = f"https://portal.azure.com/#blade/Microsoft_Azure_CreateUIDef/CustomDeploymentBlade/uri/{encoded_template}/uiFormDefinitionUri/"

    # Simpler format that works with query params in URL fragment
    # This appends parameters after the template URI with ~ separator
    deploy_url_with_params = f"https://portal.azure.com/#create/Microsoft.Template/uri/{encoded_template}/~/{encoded_params}"

    # Basic URL without pre-filled params (always works)
    simple_deploy_url = f"https://portal.azure.com/#create/Microsoft.Template/uri/{encoded_template}"

    return {
        "deploy_url": deploy_url_with_params,
        "simple_deploy_url": simple_deploy_url,
        "template_url": template_url,
        "parameters": {
            "workspaceName": workspace_name,
            "tenantId": tenant_id,
            "resourceGroup": resource_group,
            "customerApiKey": api_key,
            "saasEndpoint": "https://soc-t0-saas.azurewebsites.net",
            "location": location
        }
    }


# ============================================================================
# Workspace Creation Endpoints (Option 1: Direct ARM API)
# ============================================================================

class SubscriptionInfo(BaseModel):
    subscription_id: str
    display_name: str
    state: str


class CreateWorkspaceRequest(BaseModel):
    subscription_id: str
    resource_group: str
    workspace_name: str
    location: str
    create_resource_group: bool = True


class CreateWorkspaceResponse(BaseModel):
    workspace_id: str
    workspace_name: str
    resource_group: str
    location: str
    sentinel_enabled: bool


# Common Azure regions for Sentinel
AZURE_REGIONS = [
    {"name": "australiaeast", "display_name": "Australia East"},
    {"name": "australiasoutheast", "display_name": "Australia Southeast"},
    {"name": "eastus", "display_name": "East US"},
    {"name": "eastus2", "display_name": "East US 2"},
    {"name": "westus", "display_name": "West US"},
    {"name": "westus2", "display_name": "West US 2"},
    {"name": "centralus", "display_name": "Central US"},
    {"name": "northeurope", "display_name": "North Europe"},
    {"name": "westeurope", "display_name": "West Europe"},
    {"name": "uksouth", "display_name": "UK South"},
    {"name": "ukwest", "display_name": "UK West"},
    {"name": "southeastasia", "display_name": "Southeast Asia"},
    {"name": "japaneast", "display_name": "Japan East"},
    {"name": "canadacentral", "display_name": "Canada Central"},
]


@router.get("/subscriptions")
async def list_subscriptions(
    access_token: str = Query(..., description="Azure access token")
):
    """List Azure subscriptions accessible to the user."""
    headers = {"Authorization": f"Bearer {access_token}"}

    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://management.azure.com/subscriptions?api-version=2022-12-01",
            headers=headers
        )

        if response.status_code != 200:
            raise HTTPException(status_code=400, detail=f"Failed to list subscriptions: {response.text}")

        subs = response.json().get("value", [])

    return {
        "subscriptions": [
            SubscriptionInfo(
                subscription_id=s["subscriptionId"],
                display_name=s.get("displayName", s["subscriptionId"]),
                state=s.get("state", "Unknown")
            )
            for s in subs
            if s.get("state") == "Enabled"
        ]
    }


@router.get("/regions")
async def list_regions():
    """List available Azure regions for Sentinel deployment."""
    return {"regions": AZURE_REGIONS}


@router.post("/create-workspace", response_model=CreateWorkspaceResponse)
async def create_workspace(
    request: CreateWorkspaceRequest,
    access_token: str = Query(..., description="Azure access token")
):
    """Create Log Analytics workspace and enable Microsoft Sentinel."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        # Step 1: Create Resource Group if needed
        if request.create_resource_group:
            rg_response = await client.put(
                f"https://management.azure.com/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}?api-version=2021-04-01",
                headers=headers,
                json={
                    "location": request.location,
                    "tags": {
                        "CreatedBy": "SOC-Onboarding",
                        "Purpose": "Sentinel-Workspace"
                    }
                }
            )

            if rg_response.status_code not in [200, 201]:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to create resource group: {rg_response.text}"
                )

        # Step 2: Create Log Analytics Workspace
        workspace_response = await client.put(
            f"https://management.azure.com/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}/providers/Microsoft.OperationalInsights/workspaces/{request.workspace_name}?api-version=2023-09-01",
            headers=headers,
            json={
                "location": request.location,
                "properties": {
                    "sku": {"name": "PerGB2018"},
                    "retentionInDays": 90,
                    "features": {
                        "enableLogAccessUsingOnlyResourcePermissions": True
                    }
                },
                "tags": {
                    "CreatedBy": "SOC-Onboarding",
                    "Purpose": "Sentinel-Workspace"
                }
            }
        )

        if workspace_response.status_code not in [200, 201, 202]:
            raise HTTPException(
                status_code=400,
                detail=f"Failed to create workspace: {workspace_response.text}"
            )

        workspace_data = workspace_response.json()
        workspace_id = workspace_data.get("properties", {}).get("customerId", "")

        # Step 3: Enable Microsoft Sentinel (SecurityInsights solution)
        sentinel_response = await client.put(
            f"https://management.azure.com/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}/providers/Microsoft.OperationsManagement/solutions/SecurityInsights({request.workspace_name})?api-version=2015-11-01-preview",
            headers=headers,
            json={
                "location": request.location,
                "properties": {
                    "workspaceResourceId": f"/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}/providers/Microsoft.OperationalInsights/workspaces/{request.workspace_name}"
                },
                "plan": {
                    "name": f"SecurityInsights({request.workspace_name})",
                    "publisher": "Microsoft",
                    "product": "OMSGallery/SecurityInsights",
                    "promotionCode": ""
                }
            }
        )

        sentinel_enabled = sentinel_response.status_code in [200, 201, 202]

        if not sentinel_enabled:
            # Log warning but don't fail - workspace is still usable
            print(f"Warning: Failed to enable Sentinel: {sentinel_response.text}")

    return CreateWorkspaceResponse(
        workspace_id=workspace_id,
        workspace_name=request.workspace_name,
        resource_group=request.resource_group,
        location=request.location,
        sentinel_enabled=sentinel_enabled
    )


@router.get("/workspace-template-url")
async def get_workspace_template_url():
    """Get 'Deploy to Azure' URL for creating a Sentinel workspace (Option 2)."""
    # Template URL for workspace creation (Azure Blob Storage - publicly accessible)
    template_url = "https://soct0templates.blob.core.windows.net/templates/soc-t0-workspace.json"

    # Build Deploy to Azure URL
    base_url = "https://portal.azure.com/#create/Microsoft.Template/uri/"
    encoded_template = quote(template_url, safe="")

    deploy_url = f"{base_url}{encoded_template}"

    return {
        "deploy_url": deploy_url,
        "template_url": template_url,
        "description": "Creates a Log Analytics Workspace with Microsoft Sentinel enabled"
    }


# ============================================================================
# Post-Deployment Automation Rule Creation
# ============================================================================

class CreateAutomationRuleRequest(BaseModel):
    subscription_id: str
    resource_group: str
    workspace_name: str
    logic_app_resource_id: str
    tenant_id: str


class CreateAutomationRuleResponse(BaseModel):
    automation_rule_name: str
    status: str
    message: str


@router.post("/create-automation-rule", response_model=CreateAutomationRuleResponse)
async def create_automation_rule(
    request: CreateAutomationRuleRequest,
    access_token: str = Query(..., description="Azure access token with Sentinel permissions")
):
    """Create Sentinel automation rule after ARM template deployment completes."""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    # Azure Security Insights service principal (Microsoft Sentinel automation service)
    SENTINEL_SERVICE_PRINCIPAL_ID = "b91c279d-7753-4d97-ae0e-e11d595c78cd"
    SENTINEL_AUTOMATION_CONTRIBUTOR_ROLE_ID = "f4c81013-99ee-4d62-a7ee-b3f1f648599a"

    async with httpx.AsyncClient(timeout=60.0) as client:
        # Step 1: Grant Azure Security Insights service principal the Sentinel Automation Contributor role
        print(f"[AUTOMATION-RULE] Granting permissions to Azure Security Insights service principal...")
        role_assignment_name = secrets.token_urlsafe(16)  # Generate unique GUID
        role_assignment_payload = {
            "properties": {
                "roleDefinitionId": f"/subscriptions/{request.subscription_id}/providers/Microsoft.Authorization/roleDefinitions/{SENTINEL_AUTOMATION_CONTRIBUTOR_ROLE_ID}",
                "principalId": SENTINEL_SERVICE_PRINCIPAL_ID,
                "principalType": "ServicePrincipal"
            }
        }

        role_response = await client.put(
            f"https://management.azure.com/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}/providers/Microsoft.Authorization/roleAssignments/{role_assignment_name}?api-version=2022-04-01",
            headers=headers,
            json=role_assignment_payload
        )

        if role_response.status_code not in [200, 201, 409]:  # 409 = already exists, which is OK
            print(f"[AUTOMATION-RULE] Warning: Failed to grant permissions (HTTP {role_response.status_code}): {role_response.text}")
            # Continue anyway - role might already exist or user might have granted it manually
        else:
            print(f"[AUTOMATION-RULE] Successfully granted permissions to Azure Security Insights service principal")

        # Generate unique automation rule name
        automation_rule_name = f"SOC-T0-Auto-Analyze-{secrets.token_urlsafe(8)}"

        # Step 2: Define automation rule
        rule_definition = {
            "properties": {
                "displayName": "SOC T0 SaaS - Auto Analyze All Incidents",
                "order": 1,
                "triggeringLogic": {
                    "isEnabled": True,  # Enable immediately since permissions are handled via access token
                    "triggersOn": "Incidents",
                    "triggersWhen": "Created",
                    "conditions": []
                },
                "actions": [
                    {
                        "order": 1,
                        "actionType": "RunPlaybook",
                        "actionConfiguration": {
                            "logicAppResourceId": request.logic_app_resource_id,
                            "tenantId": request.tenant_id
                        }
                    }
                ]
            }
        }

        # Step 3: Create automation rule via Azure Management API
        response = await client.put(
            f"https://management.azure.com/subscriptions/{request.subscription_id}/resourceGroups/{request.resource_group}/providers/Microsoft.OperationalInsights/workspaces/{request.workspace_name}/providers/Microsoft.SecurityInsights/automationRules/{automation_rule_name}?api-version=2024-03-01",
            headers=headers,
            json=rule_definition
        )

        if response.status_code not in [200, 201, 202]:
            error_detail = f"Failed to create automation rule (HTTP {response.status_code}): {response.text}"
            print(f"[AUTOMATION-RULE] {error_detail}")
            raise HTTPException(status_code=400, detail=error_detail)

        print(f"[AUTOMATION-RULE] Successfully created: {automation_rule_name}")

        return CreateAutomationRuleResponse(
            automation_rule_name=automation_rule_name,
            status="created",
            message="Automation rule created successfully. Incidents will now be automatically analyzed by SOC T0 SaaS."
        )
