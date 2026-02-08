"""Application configuration using Pydantic Settings."""
import os
from typing import Optional, Union
from pydantic import field_validator
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # App settings
    app_name: str = "SOC Onboarding"
    debug: bool = False
    api_version: str = "v1"

    # Azure Multi-Tenant App (your app registration)
    multi_tenant_app_client_id: str = ""
    multi_tenant_app_client_secret: str = ""
    azure_tenant_id: str = ""

    # Cosmos DB
    cosmos_endpoint: str = ""
    cosmos_key: str = ""
    cosmos_database_name: str = "soc_onboarding"

    # Key Vault
    key_vault_url: str = ""

    # Application Insights
    appinsights_connection_string: Optional[str] = None

    # CORS - accepts comma-separated string or list
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:5175",
        "http://localhost:3000",
    ]

    @field_validator('cors_origins', mode='before')
    @classmethod
    def parse_cors_origins(cls, v: Union[str, list]) -> list:
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(',') if origin.strip()]
        return v

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
