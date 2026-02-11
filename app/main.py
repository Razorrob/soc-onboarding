"""SOC Onboarding - FastAPI Application Entry Point."""
# --- Prometheus multiprocess setup (MUST be before any prometheus_client import) ---
import os
_prom_dir = os.environ.get("PROMETHEUS_MULTIPROC_DIR", "")
if not _prom_dir:
    _prom_dir = os.path.join("/tmp", "prometheus_multiproc")
    os.environ["PROMETHEUS_MULTIPROC_DIR"] = _prom_dir
os.makedirs(_prom_dir, exist_ok=True)

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_fastapi_instrumentator import Instrumentator
from prometheus_client import CollectorRegistry, generate_latest, CONTENT_TYPE_LATEST, multiprocess
from pythonjsonlogger import jsonlogger

from app.config import get_settings
from app.api.v1.router import api_router
import app.metrics  # noqa: F401 — register custom metrics

# Configure structured JSON logging
_handler = logging.StreamHandler()
_handler.setFormatter(jsonlogger.JsonFormatter(
    fmt="%(asctime)s %(name)s %(levelname)s %(message)s",
    rename_fields={"asctime": "timestamp", "levelname": "level"},
))
logging.root.handlers = [_handler]
logging.root.setLevel(logging.INFO)
logger = logging.getLogger(__name__)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    logger.info(f"Starting {settings.app_name} v{settings.api_version}")
    yield
    logger.info(f"Shutting down {settings.app_name}")


app = FastAPI(
    title=settings.app_name,
    description="Customer Onboarding Portal for SOC T0 SaaS",
    version="1.0.0",
    lifespan=lifespan,
)

# Prometheus metrics instrumentation (instrument only, custom /metrics endpoint below)
Instrumentator().instrument(app)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API router
app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": settings.app_name,
        "version": "1.0.0"
    }


@app.get("/metrics")
async def metrics():
    """Prometheus metrics endpoint aggregated across all uvicorn workers."""
    registry = CollectorRegistry()
    multiprocess.MultiProcessCollector(registry)
    return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
