"""Custom Prometheus metrics for soc-onboarding."""
from prometheus_client import Counter, Gauge, Histogram

# --- OAuth consent ---
onb_consent_started_total = Counter(
    "onb_consent_started_total",
    "OAuth consent flows initiated",
)
onb_consent_completed_total = Counter(
    "onb_consent_completed_total",
    "OAuth consent flows completed",
    ["status"],
)

# --- Workspace listing ---
onb_workspaces_listed_total = Counter(
    "onb_workspaces_listed_total",
    "Workspace listing requests",
    ["status"],
)
onb_workspace_list_duration_seconds = Histogram(
    "onb_workspace_list_duration_seconds",
    "Workspace enumeration duration",
)

# --- Workspace creation ---
onb_workspace_creation_total = Counter(
    "onb_workspace_creation_total",
    "Workspace creation attempts",
    ["status"],
)
onb_workspace_creation_duration_seconds = Histogram(
    "onb_workspace_creation_duration_seconds",
    "Multi-step workspace creation duration",
)

# --- Onboarding completion ---
onb_onboarding_completed_total = Counter(
    "onb_onboarding_completed_total",
    "Full onboarding completions",
    ["status"],
)

# --- API keys ---
onb_api_key_generated_total = Counter(
    "onb_api_key_generated_total",
    "API keys generated",
    ["type"],
)

# --- Automation rules ---
onb_automation_rule_total = Counter(
    "onb_automation_rule_total",
    "Sentinel automation rule creation attempts",
    ["status"],
)

# --- Azure API ---
onb_azure_api_calls_total = Counter(
    "onb_azure_api_calls_total",
    "Azure Management API calls",
    ["endpoint", "status"],
)
onb_azure_api_duration_seconds = Histogram(
    "onb_azure_api_duration_seconds",
    "Azure Management API call duration",
    ["endpoint"],
)

# --- State tokens ---
onb_state_tokens_active = Gauge(
    "onb_state_tokens_active",
    "In-memory OAuth state tokens currently held",
    multiprocess_mode="livesum",
)
