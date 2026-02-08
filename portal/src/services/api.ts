const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export interface Workspace {
  subscription_id: string;
  subscription_name: string;
  resource_group: string;
  workspace_name: string;
  workspace_id: string;
  location: string;
  sentinel_enabled: boolean;
}

export interface Subscription {
  subscription_id: string;
  display_name: string;
  state: string;
}

export interface AzureRegion {
  name: string;
  display_name: string;
}

export interface OnboardingResult {
  customer_id: string;
  api_key: string;
  message: string;
}

export interface DeployInfo {
  deploy_url: string;
  template_url: string;
  parameters: {
    workspaceName: string;
    resourceGroup: string;
    customerApiKey: string;
    saasEndpoint: string;
  };
}

export interface CreateWorkspaceResult {
  workspace_id: string;
  workspace_name: string;
  resource_group: string;
  location: string;
  sentinel_enabled: boolean;
}

export interface WorkspaceTemplateInfo {
  deploy_url: string;
  template_url: string;
  description: string;
}

export interface CustomerStatus {
  exists: boolean;
  customer_id?: string;
  workspace_name?: string;
  workspace_id?: string;
  subscription_id?: string;
  resource_group?: string;
}

export interface RegenerateApiKeyResult {
  customer_id: string;
  api_key: string;
  message: string;
}

export interface WorkspacesResponse {
  workspaces: Workspace[];
  debug?: {
    subscriptions_found: number;
    subscription_names?: string[];
    workspaces_checked: number;
    errors: string[];
  };
}

export interface CreateAutomationRuleResult {
  automation_rule_name: string;
  status: string;
  message: string;
}

export const api = {
  async checkCustomerStatus(tenantId: string): Promise<CustomerStatus> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/customer-status?tenant_id=${encodeURIComponent(tenantId)}`
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to check customer status');
    }
    return response.json();
  },

  async regenerateApiKey(tenantId: string): Promise<RegenerateApiKeyResult> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/regenerate-api-key?tenant_id=${encodeURIComponent(tenantId)}`,
      { method: 'POST' }
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to regenerate API key');
    }
    return response.json();
  },

  async getWorkspaces(accessToken: string): Promise<WorkspacesResponse> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/workspaces?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to load workspaces');
    }
    const data = await response.json();
    return { workspaces: data.workspaces, debug: data.debug };
  },

  async getSubscriptions(accessToken: string): Promise<Subscription[]> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/subscriptions?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to load subscriptions');
    }
    const data = await response.json();
    return data.subscriptions;
  },

  async getRegions(): Promise<AzureRegion[]> {
    const response = await fetch(`${API_BASE}/api/v1/onboarding/regions`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to load regions');
    }
    const data = await response.json();
    return data.regions;
  },

  async createWorkspace(
    accessToken: string,
    params: {
      subscription_id: string;
      resource_group: string;
      workspace_name: string;
      location: string;
      create_resource_group?: boolean;
    }
  ): Promise<CreateWorkspaceResult> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/create-workspace?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ...params,
          create_resource_group: params.create_resource_group ?? true,
        }),
      }
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to create workspace');
    }
    return response.json();
  },

  async getWorkspaceTemplateUrl(): Promise<WorkspaceTemplateInfo> {
    const response = await fetch(`${API_BASE}/api/v1/onboarding/workspace-template-url`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get template URL');
    }
    return response.json();
  },

  async completeOnboarding(params: {
    tenant_id: string;
    subscription_id: string;
    resource_group: string;
    workspace_name: string;
    workspace_id: string;
    callback_url?: string;
    ai_analysis_enabled?: boolean;
  }): Promise<OnboardingResult> {
    const response = await fetch(`${API_BASE}/api/v1/onboarding/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to complete onboarding');
    }
    return response.json();
  },

  async getDeployUrl(params: {
    workspace_name: string;
    resource_group: string;
    api_key: string;
    subscription_id?: string;
    location?: string;
    tenant_id?: string;
  }): Promise<DeployInfo> {
    const query = new URLSearchParams({
      workspace_name: params.workspace_name,
      resource_group: params.resource_group,
      api_key: params.api_key,
    });
    if (params.subscription_id) query.append('subscription_id', params.subscription_id);
    if (params.location) query.append('location', params.location);
    if (params.tenant_id) query.append('tenant_id', params.tenant_id);
    const response = await fetch(`${API_BASE}/api/v1/onboarding/deploy-url?${query}`);
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to generate deploy URL');
    }
    return response.json();
  },

  async createAutomationRule(
    accessToken: string,
    params: {
      subscription_id: string;
      resource_group: string;
      workspace_name: string;
      logic_app_resource_id: string;
      tenant_id: string;
    }
  ): Promise<CreateAutomationRuleResult> {
    const response = await fetch(
      `${API_BASE}/api/v1/onboarding/create-automation-rule?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      }
    );
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to create automation rule');
    }
    return response.json();
  },
};
