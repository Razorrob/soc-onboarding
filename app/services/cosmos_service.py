"""Cosmos DB service for customer data management."""
import logging
import hashlib
import secrets
from datetime import datetime
from typing import Optional, List
from uuid import uuid4

from azure.cosmos import CosmosClient, PartitionKey
from azure.cosmos.exceptions import CosmosResourceNotFoundError

from app.config import get_settings

logger = logging.getLogger(__name__)


class CosmosService:
    """Service for interacting with Cosmos DB."""

    def __init__(self):
        settings = get_settings()
        self.client = CosmosClient(settings.cosmos_endpoint, settings.cosmos_key)
        self.database = self.client.get_database_client(settings.cosmos_database_name)

        # Container references
        self.customers = self.database.get_container_client("customers")
        self.audit_logs = self.database.get_container_client("audit_logs")

    # ==================== Customer Operations ====================

    def generate_api_key(self) -> tuple[str, str]:
        """Generate a new API key and its hash."""
        raw_key = f"soc_{secrets.token_urlsafe(32)}"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        return raw_key, key_hash

    async def create_customer(
        self,
        tenant_id: str,
        workspace_id: str,
        workspace_name: str,
        subscription_id: str,
        resource_group: str,
        callback_url: Optional[str] = None,
        ai_analysis_enabled: bool = True
    ) -> dict:
        """Create a new customer record."""
        raw_api_key, api_key_hash = self.generate_api_key()

        customer = {
            "id": str(uuid4()),
            "tenant_id": tenant_id,
            "workspace_id": workspace_id,
            "workspace_name": workspace_name,
            "subscription_id": subscription_id,
            "resource_group": resource_group,
            "api_key_hash": api_key_hash,
            "callback_url": callback_url,
            "ai_analysis_enabled": ai_analysis_enabled,
            "status": "active",
            "created_at": datetime.utcnow().isoformat() + 'Z',
            "updated_at": datetime.utcnow().isoformat() + 'Z',
            "analysis_count": 0
        }

        self.customers.create_item(customer)
        logger.info(f"Created customer {customer['id']} for tenant {tenant_id}")

        # Return customer with the raw API key (only shown once)
        return {**customer, "api_key": raw_api_key}

    async def get_customer_by_api_key(self, api_key: str) -> Optional[dict]:
        """Look up customer by API key."""
        if not api_key or not api_key.startswith("soc_"):
            return None

        api_key_hash = hashlib.sha256(api_key.encode()).hexdigest()

        query = "SELECT * FROM c WHERE c.api_key_hash = @hash AND c.status = 'active'"
        params = [{"name": "@hash", "value": api_key_hash}]

        items = list(self.customers.query_items(
            query=query,
            parameters=params,
            enable_cross_partition_query=True
        ))

        if items:
            return items[0]
        return None

    async def get_customer_by_tenant(self, tenant_id: str) -> Optional[dict]:
        """Get customer by tenant ID."""
        try:
            items = list(self.customers.query_items(
                query="SELECT * FROM c WHERE c.tenant_id = @tenant_id",
                parameters=[{"name": "@tenant_id", "value": tenant_id}],
                enable_cross_partition_query=True
            ))
            return items[0] if items else None
        except Exception as e:
            logger.error(f"Error getting customer by tenant: {e}")
            return None

    async def get_customer(self, customer_id: str) -> Optional[dict]:
        """Get customer by ID."""
        try:
            items = list(self.customers.query_items(
                query="SELECT * FROM c WHERE c.id = @id",
                parameters=[{"name": "@id", "value": customer_id}],
                enable_cross_partition_query=True
            ))
            return items[0] if items else None
        except Exception as e:
            logger.error(f"Error getting customer by ID: {e}")
            return None

    async def update_customer(self, customer_id: str, tenant_id: str, updates: dict) -> dict:
        """Update customer record."""
        customer = self.customers.read_item(customer_id, partition_key=tenant_id)
        customer.update(updates)
        customer["updated_at"] = datetime.utcnow().isoformat() + 'Z'
        return self.customers.replace_item(customer_id, customer)

    async def update_customer_api_key(self, customer_id: str, new_api_key_hash: str) -> dict:
        """Update customer's API key hash (for key regeneration)."""
        # First, find the customer to get the tenant_id (partition key)
        query = "SELECT * FROM c WHERE c.id = @id"
        params = [{"name": "@id", "value": customer_id}]
        items = list(self.customers.query_items(
            query=query,
            parameters=params,
            enable_cross_partition_query=True
        ))

        if not items:
            raise ValueError(f"Customer {customer_id} not found")

        customer = items[0]
        customer["api_key_hash"] = new_api_key_hash
        customer["updated_at"] = datetime.utcnow().isoformat() + 'Z'

        return self.customers.replace_item(customer_id, customer)

    async def list_customers(self, limit: int = 100) -> List[dict]:
        """List all active customers."""
        query = "SELECT * FROM c WHERE c.status = 'active' ORDER BY c.created_at DESC OFFSET 0 LIMIT @limit"
        items = list(self.customers.query_items(
            query=query,
            parameters=[{"name": "@limit", "value": limit}],
            enable_cross_partition_query=True
        ))
        return items

    # ==================== Audit Log Operations ====================

    async def log_audit_event(
        self,
        customer_id: str,
        event_type: str,
        details: dict,
        user_id: Optional[str] = None
    ) -> dict:
        """Log an audit event."""
        audit_entry = {
            "id": str(uuid4()),
            "customer_id": customer_id,
            "event_type": event_type,
            "details": details,
            "user_id": user_id,
            "timestamp": datetime.utcnow().isoformat() + 'Z',
            "ttl": 31536000  # 365 days
        }

        self.audit_logs.create_item(audit_entry)
        return audit_entry

    async def get_audit_logs(
        self,
        customer_id: str,
        event_type: Optional[str] = None,
        limit: int = 100
    ) -> List[dict]:
        """Get audit logs for a customer."""
        query = "SELECT * FROM c WHERE c.customer_id = @customer_id"
        params = [{"name": "@customer_id", "value": customer_id}]

        if event_type:
            query += " AND c.event_type = @event_type"
            params.append({"name": "@event_type", "value": event_type})

        query += " ORDER BY c.timestamp DESC OFFSET 0 LIMIT @limit"
        params.append({"name": "@limit", "value": limit})

        return list(self.audit_logs.query_items(query=query, parameters=params))


# Singleton instance
_cosmos_service: Optional[CosmosService] = None


def get_cosmos_service() -> CosmosService:
    """Get or create Cosmos DB service singleton."""
    global _cosmos_service
    if _cosmos_service is None:
        _cosmos_service = CosmosService()
    return _cosmos_service
