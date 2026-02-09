"""PostgreSQL customer service for creating customers in Logs2Graph database."""
import hashlib
import logging
import secrets
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import get_settings

logger = logging.getLogger(__name__)

# Module-level engine (initialized lazily)
_engine = None
_session_factory = None


def _get_engine():
    """Get or create the async engine."""
    global _engine, _session_factory
    if _engine is None:
        settings = get_settings()
        if not settings.postgres_url:
            raise RuntimeError("POSTGRES_URL not configured")
        _engine = create_async_engine(settings.postgres_url, echo=settings.debug)
        _session_factory = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)
    return _engine, _session_factory


def generate_api_key() -> tuple[str, str, str]:
    """Generate a secure API key with soc_ prefix.

    Returns:
        Tuple of (raw_key, key_hash, key_prefix)
    """
    raw_key = f"soc_{secrets.token_urlsafe(32)}"
    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
    key_prefix = raw_key[:8]
    return raw_key, key_hash, key_prefix


class PostgresCustomerService:
    """Service for managing customers in the Logs2Graph PostgreSQL database."""

    async def create_customer(
        self,
        tenant_id: str,
        workspace_id: str,
        workspace_name: str,
        subscription_id: str,
        resource_group: str,
        callback_url: Optional[str] = None,
        ai_analysis_enabled: bool = True,
    ) -> dict:
        """Create a new customer record in PostgreSQL.

        Returns:
            Dict with customer data including the raw API key (only returned once).
        """
        _, session_factory = _get_engine()

        raw_key, key_hash, key_prefix = generate_api_key()
        customer_id = str(uuid.uuid4())
        now = datetime.utcnow()

        async with session_factory() as session:
            await session.execute(
                text("""
                    INSERT INTO customers (
                        id, name, email, tenant_id, workspace_id,
                        api_key_hash, api_key_prefix,
                        callback_url, status, notes,
                        created_at, updated_at,
                        incident_count, ai_analysis_enabled,
                        workspace_name, azure_subscription_id, resource_group,
                        subscription_tier, monthly_incident_count
                    ) VALUES (
                        :id, :name, :email, :tenant_id, :workspace_id,
                        :api_key_hash, :api_key_prefix,
                        :callback_url, :status, :notes,
                        :created_at, :updated_at,
                        :incident_count, :ai_analysis_enabled,
                        :workspace_name, :azure_subscription_id, :resource_group,
                        :subscription_tier, :monthly_incident_count
                    )
                """),
                {
                    "id": customer_id,
                    "name": workspace_name,
                    "email": f"{tenant_id}@onboard.soctierzero.com",
                    "tenant_id": tenant_id,
                    "workspace_id": workspace_id,
                    "api_key_hash": key_hash,
                    "api_key_prefix": key_prefix,
                    "callback_url": callback_url,
                    "status": "active",
                    "notes": None,
                    "created_at": now,
                    "updated_at": now,
                    "incident_count": 0,
                    "ai_analysis_enabled": ai_analysis_enabled,
                    "workspace_name": workspace_name,
                    "azure_subscription_id": subscription_id,
                    "resource_group": resource_group,
                    "subscription_tier": "free",
                    "monthly_incident_count": 0,
                },
            )
            await session.commit()

        logger.info(f"Created customer {customer_id} for tenant {tenant_id} in PostgreSQL")

        return {
            "id": customer_id,
            "tenant_id": tenant_id,
            "workspace_id": workspace_id,
            "workspace_name": workspace_name,
            "subscription_id": subscription_id,
            "resource_group": resource_group,
            "api_key": raw_key,
            "status": "active",
        }

    async def get_customer_by_tenant(self, tenant_id: str) -> Optional[dict]:
        """Get customer by tenant ID."""
        _, session_factory = _get_engine()

        async with session_factory() as session:
            result = await session.execute(
                text("SELECT id, tenant_id, workspace_id, workspace_name, azure_subscription_id, resource_group, status FROM customers WHERE tenant_id = :tid LIMIT 1"),
                {"tid": tenant_id},
            )
            row = result.mappings().first()
            if row:
                return {
                    "id": row["id"],
                    "tenant_id": row["tenant_id"],
                    "workspace_id": row["workspace_id"],
                    "workspace_name": row["workspace_name"],
                    "subscription_id": row["azure_subscription_id"],
                    "resource_group": row["resource_group"],
                    "status": row["status"],
                }
            return None

    async def regenerate_api_key(self, customer_id: str) -> str:
        """Regenerate API key for a customer.

        Returns:
            The new raw API key (only returned once).
        """
        _, session_factory = _get_engine()

        raw_key, key_hash, key_prefix = generate_api_key()

        async with session_factory() as session:
            result = await session.execute(
                text("UPDATE customers SET api_key_hash = :hash, api_key_prefix = :prefix, updated_at = :now WHERE id = :id"),
                {"hash": key_hash, "prefix": key_prefix, "now": datetime.utcnow(), "id": customer_id},
            )
            if result.rowcount == 0:
                raise ValueError(f"Customer {customer_id} not found")
            await session.commit()

        logger.info(f"Regenerated API key for customer {customer_id}")
        return raw_key


# Singleton
_pg_service: Optional[PostgresCustomerService] = None


def get_postgres_customer_service() -> PostgresCustomerService:
    """Get or create PostgreSQL customer service singleton."""
    global _pg_service
    if _pg_service is None:
        _pg_service = PostgresCustomerService()
    return _pg_service
