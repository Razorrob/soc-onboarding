"""API v1 router that aggregates all v1 endpoints."""
from fastapi import APIRouter

from app.api.v1 import onboarding

api_router = APIRouter()

# Include onboarding endpoints
api_router.include_router(
    onboarding.router,
    prefix="/onboarding",
    tags=["onboarding"]
)
