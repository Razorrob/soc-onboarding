FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Expose port
EXPOSE 8000

# Environment variables for Prometheus multiprocess mode
ENV PROMETHEUS_MULTIPROC_DIR=/tmp/prometheus_multiproc
RUN mkdir -p /tmp/prometheus_multiproc

# Run the application
# Clear stale multiprocess metric files before starting
CMD ["sh", "-c", "rm -rf ${PROMETHEUS_MULTIPROC_DIR}/* && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
