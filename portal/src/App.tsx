import { useState, useEffect } from 'react'
import { useMsal, useIsAuthenticated } from '@azure/msal-react'
import { loginRequest } from './authConfig'
import { api } from './services/api'
import type { Workspace, OnboardingResult, DeployInfo, Subscription, AzureRegion, WorkspacesResponse, CustomerStatus, CreateAutomationRuleResult } from './services/api'

type Step = 'connect' | 'workspace' | 'create-workspace' | 'apikey' | 'deploy' | 'automation-rule'
type CreateOption = 'direct' | 'template' | 'managed' | null

function App() {
  const { instance, accounts } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const { inProgress } = useMsal()

  const [step, setStep] = useState<Step>('connect')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [selectedWorkspace, setSelectedWorkspace] = useState<Workspace | null>(null)
  const [onboardingResult, setOnboardingResult] = useState<OnboardingResult | null>(null)
  const [deployInfo, setDeployInfo] = useState<DeployInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [workspaceCopied, setWorkspaceCopied] = useState(false)
  const [resourceGroupCopied, setResourceGroupCopied] = useState(false)

  // Create workspace state
  const [, setCreateOption] = useState<CreateOption>(null)
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [regions, setRegions] = useState<AzureRegion[]>([])
  const [selectedSubscription, setSelectedSubscription] = useState<string>('')
  const [selectedRegion, setSelectedRegion] = useState<string>('')
  const [resourceGroupName, setResourceGroupName] = useState<string>('')
  const [workspaceName, setWorkspaceName] = useState<string>('')
  const [showManagedPopup, setShowManagedPopup] = useState(false)
  const [showDeployTemplatePopup, setShowDeployTemplatePopup] = useState(false)
  const [deployTemplateUrl, setDeployTemplateUrl] = useState<string | null>(null)
  const [workspaceDebug, setWorkspaceDebug] = useState<WorkspacesResponse['debug'] | null>(null)
  const [existingCustomer, setExistingCustomer] = useState<CustomerStatus | null>(null)
  const [regeneratedApiKey, setRegeneratedApiKey] = useState<string | null>(null)
  const [automationRuleResult, setAutomationRuleResult] = useState<CreateAutomationRuleResult | null>(null)
  const [automationRuleLoading, setAutomationRuleLoading] = useState(false)
  const [deploymentComplete, setDeploymentComplete] = useState(false)
  const [checkingDeployment, setCheckingDeployment] = useState(false)

  // Get access token after authentication and check customer status
  useEffect(() => {
    if (isAuthenticated && accounts.length > 0 && !accessToken) {
      instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0]
      }).then(async (response) => {
        setAccessToken(response.accessToken)

        // Check if customer already exists for this tenant
        const tenantId = accounts[0]?.tenantId || ''
        if (tenantId) {
          try {
            const status = await api.checkCustomerStatus(tenantId)
            if (status.exists) {
              setExistingCustomer(status)
              // Set workspace info from existing customer
              if (status.workspace_name && status.workspace_id) {
                setSelectedWorkspace({
                  subscription_id: status.subscription_id || '',
                  subscription_name: '',
                  resource_group: status.resource_group || '',
                  workspace_name: status.workspace_name,
                  workspace_id: status.workspace_id,
                  location: '',
                  sentinel_enabled: true
                })
              }
            }
          } catch (err) {
            console.error('Failed to check customer status:', err)
          }
        }

        setStep('workspace')
      }).catch(err => {
        console.error('Failed to acquire token:', err)
        setError('Failed to get access token. Please try signing in again.')
      })
    }
  }, [isAuthenticated, accounts, instance, accessToken])

  // Load workspaces when we have a token
  useEffect(() => {
    if (accessToken && step === 'workspace' && workspaces.length === 0) {
      loadWorkspaces()
    }
  }, [accessToken, step])

  // Auto-check deployment status when on deploy step
  useEffect(() => {
    if (step === 'deploy' && accessToken && selectedWorkspace && !deploymentComplete && !automationRuleResult) {
      // Check immediately
      checkDeploymentStatus()

      // Set up polling every 10 seconds
      const interval = setInterval(() => {
        checkDeploymentStatus()
      }, 10000)

      return () => clearInterval(interval)
    }
  }, [step, accessToken, selectedWorkspace, deploymentComplete, automationRuleResult])

  const handleConnect = () => {
    setError(null)
    instance.loginRedirect(loginRequest)
  }

  const loadWorkspaces = async (forceRefreshToken = false) => {
    setLoading(true)
    setError(null)
    try {
      // Always get a fresh token to avoid expiration issues
      let token = accessToken
      if (forceRefreshToken || !token) {
        const tokenResponse = await instance.acquireTokenSilent({
          ...loginRequest,
          account: accounts[0]
        })
        token = tokenResponse.accessToken
        setAccessToken(token)
      }

      if (!token) {
        setError('No access token available. Please sign in again.')
        return
      }

      const response = await api.getWorkspaces(token)
      setWorkspaces(response.workspaces)
      setWorkspaceDebug(response.debug || null)
      console.log('[DEBUG] Workspaces response:', response)
    } catch (err) {
      // If token acquisition failed, try interactive login
      if (err instanceof Error && err.message.includes('token')) {
        setError('Session expired. Please sign in again.')
        setStep('connect')
        return
      }
      setError(err instanceof Error ? err.message : 'Failed to load workspaces')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectWorkspace = async (workspace: Workspace) => {
    setSelectedWorkspace(workspace)
    setLoading(true)
    setError(null)

    try {
      // Get tenant ID from the account
      const tenantId = accounts[0]?.tenantId || ''

      // If customer already exists, skip onboarding and go directly to deploy
      if (existingCustomer?.exists) {
        // Use the regenerated API key if available, otherwise prompt to regenerate
        if (!regeneratedApiKey) {
          setError('Please regenerate your API key first using the button above.')
          setLoading(false)
          return
        }

        // Go directly to deploy step
        const info = await api.getDeployUrl({
          workspace_name: workspace.workspace_name,
          resource_group: workspace.resource_group,
          api_key: regeneratedApiKey,
          subscription_id: workspace.subscription_id,
          location: workspace.location,
          tenant_id: tenantId
        })
        setDeployInfo(info)
        setStep('deploy')
        setLoading(false)
        return
      }

      // New customer - complete onboarding
      const result = await api.completeOnboarding({
        tenant_id: tenantId,
        subscription_id: workspace.subscription_id,
        resource_group: workspace.resource_group,
        workspace_name: workspace.workspace_name,
        workspace_id: workspace.workspace_id,
        ai_analysis_enabled: true
      })

      setOnboardingResult(result)
      setStep('apikey')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete onboarding')
    } finally {
      setLoading(false)
    }
  }

  const handleCopyApiKey = async () => {
    if (!onboardingResult) return
    await navigator.clipboard.writeText(onboardingResult.api_key)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleCopyWorkspace = async () => {
    if (!selectedWorkspace) return
    await navigator.clipboard.writeText(selectedWorkspace.workspace_name)
    setWorkspaceCopied(true)
    setTimeout(() => setWorkspaceCopied(false), 2000)
  }

  const handleCopyResourceGroup = async () => {
    if (!selectedWorkspace) return
    await navigator.clipboard.writeText(selectedWorkspace.resource_group)
    setResourceGroupCopied(true)
    setTimeout(() => setResourceGroupCopied(false), 2000)
  }

  // Load subscriptions and regions for workspace creation
  const loadCreateWorkspaceData = async () => {
    if (!accessToken) return
    setLoading(true)
    try {
      const [subs, regs] = await Promise.all([
        api.getSubscriptions(accessToken),
        api.getRegions()
      ])
      setSubscriptions(subs)
      setRegions(regs)
      if (subs.length > 0) setSelectedSubscription(subs[0].subscription_id)
      if (regs.length > 0) setSelectedRegion(regs[0].name)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateWorkspaceDirect = async () => {
    if (!accessToken || !selectedSubscription || !selectedRegion || !resourceGroupName || !workspaceName) {
      setError('Please fill in all fields')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await api.createWorkspace(accessToken, {
        subscription_id: selectedSubscription,
        resource_group: resourceGroupName,
        workspace_name: workspaceName,
        location: selectedRegion,
        create_resource_group: true
      })

      // Convert to Workspace format and select it
      const newWorkspace: Workspace = {
        subscription_id: selectedSubscription,
        subscription_name: subscriptions.find(s => s.subscription_id === selectedSubscription)?.display_name || selectedSubscription,
        resource_group: result.resource_group,
        workspace_name: result.workspace_name,
        workspace_id: result.workspace_id,
        location: result.location,
        sentinel_enabled: result.sentinel_enabled
      }
      setSelectedWorkspace(newWorkspace)

      // Complete onboarding with new workspace
      const tenantId = accounts[0]?.tenantId || ''
      const onboardResult = await api.completeOnboarding({
        tenant_id: tenantId,
        subscription_id: newWorkspace.subscription_id,
        resource_group: newWorkspace.resource_group,
        workspace_name: newWorkspace.workspace_name,
        workspace_id: newWorkspace.workspace_id,
        ai_analysis_enabled: true
      })
      setOnboardingResult(onboardResult)
      setStep('apikey')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
    } finally {
      setLoading(false)
    }
  }

  const handleDeployToAzureWorkspace = async () => {
    setLoading(true)
    setError(null)
    try {
      const info = await api.getWorkspaceTemplateUrl()
      setDeployTemplateUrl(info.deploy_url)
      setShowDeployTemplatePopup(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get template URL')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectCreateOption = (option: CreateOption) => {
    if (option === 'managed') {
      setShowManagedPopup(true)
      return
    }
    setCreateOption(option)
    if (option === 'direct') {
      setStep('create-workspace')
      loadCreateWorkspaceData()
    }
  }

  const handleProceedToDeploy = async () => {
    if (!selectedWorkspace || !onboardingResult) return
    setLoading(true)
    setError(null)

    try {
      const tenantId = accounts[0]?.tenantId || ''
      const info = await api.getDeployUrl({
        workspace_name: selectedWorkspace.workspace_name,
        resource_group: selectedWorkspace.resource_group,
        api_key: onboardingResult.api_key,
        subscription_id: selectedWorkspace.subscription_id,
        location: selectedWorkspace.location,
        tenant_id: tenantId
      })
      setDeployInfo(info)
      setStep('deploy')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate deploy URL')
    } finally {
      setLoading(false)
    }
  }

  const checkDeploymentStatus = async () => {
    if (!accessToken || !selectedWorkspace) return false

    setCheckingDeployment(true)

    try {
      // Get fresh access token to avoid expiration issues
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0]
      })

      // Check if Logic App exists by making a GET request to Azure Management API
      const logicAppUrl = `https://management.azure.com/subscriptions/${selectedWorkspace.subscription_id}/resourceGroups/${selectedWorkspace.resource_group}/providers/Microsoft.Logic/workflows/SOC-T0-SaaS-Playbook?api-version=2019-05-01`

      const response = await fetch(logicAppUrl, {
        headers: {
          'Authorization': `Bearer ${tokenResponse.accessToken}`,
        }
      })

      if (response.ok) {
        setDeploymentComplete(true)

        // Automatically create automation rule after deployment completes
        if (!automationRuleResult) {
          await createAutomationRuleAfterDeployment(tokenResponse.accessToken)
        }

        return true
      }
      return false
    } catch (err) {
      console.error('Failed to check deployment status:', err)
      return false
    } finally {
      setCheckingDeployment(false)
    }
  }

  const handleCheckDeployment = async () => {
    await checkDeploymentStatus()
  }

  // Auto-check deployment status every 10 seconds when on deploy step
  useEffect(() => {
    if (step === 'deploy' && !deploymentComplete && !automationRuleResult) {
      const interval = setInterval(async () => {
        await checkDeploymentStatus()
      }, 10000) // Check every 10 seconds

      return () => clearInterval(interval)
    }
  }, [step, deploymentComplete, automationRuleResult])

  const createAutomationRuleAfterDeployment = async (accessToken: string) => {
    if (!selectedWorkspace) return

    setAutomationRuleLoading(true)

    try {
      const tenantId = accounts[0]?.tenantId || ''
      const logicAppResourceId = `/subscriptions/${selectedWorkspace.subscription_id}/resourceGroups/${selectedWorkspace.resource_group}/providers/Microsoft.Logic/workflows/SOC-T0-SaaS-Playbook`

      const result = await api.createAutomationRule(
        accessToken,
        {
          subscription_id: selectedWorkspace.subscription_id,
          resource_group: selectedWorkspace.resource_group,
          workspace_name: selectedWorkspace.workspace_name,
          logic_app_resource_id: logicAppResourceId,
          tenant_id: tenantId
        }
      )

      setAutomationRuleResult(result)
    } catch (err) {
      console.error('Failed to automatically create automation rule:', err)
      // Don't set error state for automatic creation - user can still manually trigger
    } finally {
      setAutomationRuleLoading(false)
    }
  }

  const handleCreateAutomationRule = async () => {
    if (!accessToken || !selectedWorkspace || !deployInfo) return

    setAutomationRuleLoading(true)
    setError(null)

    try {
      // Get fresh access token to avoid expiration issues
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account: accounts[0]
      })

      await createAutomationRuleAfterDeployment(tokenResponse.accessToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create automation rule')
    }
  }

  // Loading state
  if (inProgress !== 'none') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Authenticating...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="max-w-6xl mx-auto px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                OB
              </div>
              <div>
                <h1 className="text-xl font-semibold text-foreground">SOC Onboarding</h1>
                <p className="text-sm text-muted-foreground">Customer Onboarding Portal</p>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Progress Steps */}
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="flex items-center justify-center mb-8">
          {['connect', 'workspace', 'apikey', 'deploy'].map((s, i) => (
            <div key={s} className="flex items-center">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                step === s ? 'bg-primary text-primary-foreground' :
                ['connect', 'workspace', 'apikey', 'deploy'].indexOf(step) > i ? 'bg-green-600 text-foreground' :
                'bg-muted text-muted-foreground'
              }`}>
                {['connect', 'workspace', 'apikey', 'deploy'].indexOf(step) > i ? '✓' : i + 1}
              </div>
              {i < 3 && <div className={`w-16 h-1 transition-colors ${
                ['connect', 'workspace', 'apikey', 'deploy'].indexOf(step) > i ? 'bg-green-600' : 'bg-muted'
              }`}></div>}
            </div>
          ))}
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-900 border border-red-700 text-red-200 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* Step 1: Connect */}
        {step === 'connect' && (
          <div className="bg-card rounded-lg p-8 border border text-center">
            <div className="w-20 h-20 bg-primary rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-4">Connect Your Azure Tenant</h2>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              To enable SOC analysis for your Sentinel incidents, we need permission to read your Log Analytics workspaces and query incident data.
            </p>
            <div className="bg-muted rounded-lg p-4 mb-6 text-left max-w-md mx-auto">
              <p className="text-foreground text-sm font-medium mb-2">Permissions requested:</p>
              <ul className="text-muted-foreground text-sm space-y-1">
                <li>- Read Log Analytics workspaces</li>
                <li>- Query Sentinel incident data</li>
              </ul>
            </div>
            <button
              onClick={handleConnect}
              className="bg-primary hover:bg-primary/90 text-foreground font-medium py-3 px-8 rounded-lg flex items-center justify-center gap-3 mx-auto"
            >
              <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none">
                <rect x="1" y="1" width="9" height="9" fill="#f25022"/>
                <rect x="11" y="1" width="9" height="9" fill="#7fba00"/>
                <rect x="1" y="11" width="9" height="9" fill="#00a4ef"/>
                <rect x="11" y="11" width="9" height="9" fill="#ffb900"/>
              </svg>
              Connect with Azure AD
            </button>
            <p className="text-muted-foreground text-sm mt-4">
              Requires Azure AD Global Administrator or Application Administrator
            </p>
          </div>
        )}

        {/* Step 2: Select Workspace */}
        {step === 'workspace' && (
          <div className="bg-card rounded-lg p-8 border border">
            {/* Existing Customer Banner */}
            {existingCustomer?.exists && (
              <div className="bg-blue-900 border border-blue-700 rounded-lg p-4 mb-6">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 bg-primary rounded-full flex items-center justify-center flex-shrink-0">
                    <svg className="w-5 h-5 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-foreground font-medium">You're already onboarded!</h3>
                    <p className="text-blue-200 text-sm mt-1">
                      Workspace: <span className="font-medium">{existingCustomer.workspace_name}</span>
                    </p>

                    {/* Regenerated API Key Display */}
                    {regeneratedApiKey ? (
                      <div className="mt-3 bg-green-900 border border-green-700 rounded-lg p-3">
                        <p className="text-green-200 text-xs font-medium mb-2">Your new API Key (save it now!):</p>
                        <div className="flex items-center gap-2">
                          <code className="bg-background text-green-300 px-2 py-1 rounded text-xs flex-1 overflow-x-auto">
                            {regeneratedApiKey}
                          </code>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(regeneratedApiKey)
                            }}
                            className="bg-green-600 hover:bg-green-700 text-foreground text-xs py-1 px-2 rounded"
                          >
                            Copy
                          </button>
                        </div>
                        <p className="text-yellow-300 text-xs mt-2">Save this key! It won't be shown again.</p>
                      </div>
                    ) : (
                      <div className="mt-3">
                        <p className="text-blue-300 text-xs mb-2">
                          Lost your API key? Generate a new one (this will invalidate the old key):
                        </p>
                        <button
                          onClick={async () => {
                            const tenantId = accounts[0]?.tenantId || ''
                            if (!tenantId) return
                            setLoading(true)
                            try {
                              const result = await api.regenerateApiKey(tenantId)
                              setRegeneratedApiKey(result.api_key)
                            } catch (err) {
                              setError(err instanceof Error ? err.message : 'Failed to regenerate API key')
                            } finally {
                              setLoading(false)
                            }
                          }}
                          disabled={loading}
                          className="bg-yellow-600 hover:bg-yellow-700 text-foreground text-sm font-medium py-2 px-4 rounded disabled:opacity-50"
                        >
                          {loading ? 'Regenerating...' : 'Regenerate API Key'}
                        </button>
                      </div>
                    )}

                    <p className="text-blue-300 text-xs mt-4">
                      Select a workspace below, then proceed to deploy.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <h2 className="text-2xl font-bold text-foreground mb-2">Select Your Sentinel Workspace</h2>
            <p className="text-muted-foreground mb-6">Choose the Log Analytics workspace where Microsoft Sentinel is enabled.</p>

            {loading ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400 mx-auto"></div>
                <p className="mt-4 text-muted-foreground">Loading workspaces...</p>
              </div>
            ) : workspaces.length === 0 ? (
              <div className="py-6">
                <div className="text-center mb-6">
                  <p className="text-muted-foreground mb-2">No Log Analytics workspaces found in your subscriptions.</p>
                  <p className="text-muted-foreground text-sm">Choose how you'd like to create your Sentinel workspace:</p>
                </div>

                {/* Debug Info */}
                {workspaceDebug && (
                  <div className="bg-background border border rounded-lg p-4 mb-6 text-left text-xs">
                    <p className="text-muted-foreground font-medium mb-2">Debug Info:</p>
                    <ul className="text-muted-foreground space-y-1">
                      <li>Subscriptions found: <span className="text-foreground">{workspaceDebug.subscriptions_found}</span></li>
                      {workspaceDebug.subscription_names && workspaceDebug.subscription_names.length > 0 && (
                        <li>Subscription names: <span className="text-foreground">{workspaceDebug.subscription_names.join(', ')}</span></li>
                      )}
                      <li>Workspaces checked: <span className="text-foreground">{workspaceDebug.workspaces_checked}</span></li>
                      {workspaceDebug.errors.length > 0 && (
                        <li className="text-red-400">
                          Errors: {workspaceDebug.errors.join(', ')}
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Three Options */}
                <div className="grid gap-4 md:grid-cols-3">
                  {/* Option 1: Direct Creation */}
                  <div
                    onClick={() => handleSelectCreateOption('direct')}
                    className="border border-input rounded-lg p-6 cursor-pointer hover:border-primary hover:bg-accent transition-colors"
                  >
                    <div className="w-12 h-12 bg-primary rounded-lg flex items-center justify-center mx-auto mb-4">
                      <svg className="w-6 h-6 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                    <h3 className="text-foreground font-medium text-center mb-2">Quick Create</h3>
                    <p className="text-muted-foreground text-sm text-center">
                      We'll create the workspace for you automatically using your Azure credentials.
                    </p>
                    <div className="mt-4 text-center">
                      <span className="text-primary text-sm">Recommended</span>
                    </div>
                  </div>

                  {/* Option 2: Deploy to Azure */}
                  <div
                    onClick={handleDeployToAzureWorkspace}
                    className="border border-input rounded-lg p-6 cursor-pointer hover:border-purple-500 hover:bg-accent transition-colors"
                  >
                    <div className="w-12 h-12 bg-purple-600 rounded-lg flex items-center justify-center mx-auto mb-4">
                      <svg className="w-6 h-6 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                      </svg>
                    </div>
                    <h3 className="text-foreground font-medium text-center mb-2">Deploy to Azure</h3>
                    <p className="text-muted-foreground text-sm text-center">
                      Open Azure Portal with a pre-configured ARM template for full control.
                    </p>
                    <div className="mt-4 text-center">
                      <span className="text-purple-400 text-sm">Manual Control</span>
                    </div>
                  </div>

                  {/* Option 3: Managed SIEM */}
                  <div
                    onClick={() => handleSelectCreateOption('managed')}
                    className="border border-input rounded-lg p-6 cursor-pointer hover:border-green-500 hover:bg-accent transition-colors relative"
                  >
                    <div className="absolute top-2 right-2 bg-green-600 text-foreground text-xs px-2 py-1 rounded">
                      Coming Soon
                    </div>
                    <div className="w-12 h-12 bg-green-600 rounded-lg flex items-center justify-center mx-auto mb-4">
                      <svg className="w-6 h-6 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <h3 className="text-foreground font-medium text-center mb-2">Managed SIEM</h3>
                    <p className="text-muted-foreground text-sm text-center">
                      Full managed service with analytics rules, workbooks, and 24/7 monitoring.
                    </p>
                    <div className="mt-4 text-center">
                      <span className="text-green-400 text-sm">Enterprise Plan</span>
                    </div>
                  </div>
                </div>

                <div className="mt-6 text-center">
                  <button
                    onClick={() => loadWorkspaces(true)}
                    className="text-primary hover:text-blue-300 text-sm flex items-center gap-2 mx-auto"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh workspace list
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Existing Workspaces */}
                <div>
                  <h3 className="text-foreground font-medium mb-3">Select an existing workspace:</h3>
                  <div className="space-y-3">
                    {workspaces.map((ws) => (
                      <div
                        key={`${ws.subscription_id}-${ws.workspace_name}`}
                        className={`border rounded-lg p-4 cursor-pointer transition-colors ${
                          ws.sentinel_enabled
                            ? 'border-input hover:border-primary hover:bg-accent'
                            : 'border opacity-50 cursor-not-allowed'
                        }`}
                        onClick={() => ws.sentinel_enabled && handleSelectWorkspace(ws)}
                      >
                        <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`w-3 h-3 rounded-full ${ws.sentinel_enabled ? 'bg-green-500' : 'bg-gray-500'}`}></span>
                          <h3 className="text-foreground font-medium">{ws.workspace_name}</h3>
                        </div>
                        <p className="text-muted-foreground text-sm mt-1">
                          {ws.subscription_name} / {ws.resource_group}
                        </p>
                        <p className="text-muted-foreground text-xs mt-1">{ws.location}</p>
                      </div>
                      <div className="text-right">
                        {ws.sentinel_enabled ? (
                          <span className="text-green-400 text-sm">Sentinel Enabled</span>
                        ) : (
                          <span className="text-muted-foreground text-sm">Sentinel Not Enabled</span>
                        )}
                      </div>
                    </div>
                  </div>
                    ))}
                  </div>
                </div>

                <div className="mt-6 text-center">
                  <button
                    onClick={() => loadWorkspaces(true)}
                    className="text-primary hover:text-blue-300 text-sm flex items-center gap-2 mx-auto"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Refresh workspace list
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 3: API Key */}
        {step === 'apikey' && onboardingResult && (
          <div className="bg-card rounded-lg p-8 border border text-center">
            <div className="w-20 h-20 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <svg className="w-10 h-10 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-4">Your API Key</h2>
            <p className="text-muted-foreground mb-6">
              Save this API key securely. You'll need it for the deployment step.
            </p>

            <div className="bg-background rounded-lg p-4 mb-4 flex items-center justify-between max-w-lg mx-auto">
              <code className="text-green-400 text-sm font-mono break-all">
                {onboardingResult.api_key}
              </code>
              <button
                onClick={handleCopyApiKey}
                className="ml-4 bg-muted hover:bg-muted text-foreground px-3 py-1 rounded text-sm flex-shrink-0"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>

            <div className="bg-yellow-900 border border-yellow-700 rounded-lg p-4 mb-6 max-w-lg mx-auto">
              <p className="text-yellow-200 text-sm">
                <strong>Important:</strong> This is the only time you'll see this API key.
                Store it securely before proceeding.
              </p>
            </div>

            <button
              onClick={handleProceedToDeploy}
              disabled={loading}
              className="bg-primary hover:bg-primary/90 text-foreground font-medium py-3 px-8 rounded-lg disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Continue to Deployment'}
            </button>
          </div>
        )}

        {/* Step 4: Deploy */}
        {step === 'deploy' && deployInfo && selectedWorkspace && (
          <div className="bg-card rounded-lg p-8 border border">
            <div className="text-center mb-8">
              <div className="w-20 h-20 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-10 h-10 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-foreground mb-2">Deploy to Your Azure</h2>
              <p className="text-muted-foreground">
                Deploy the SOC Logic App and Automation Rule to your Azure environment.
              </p>
            </div>

            {/* Deployment Monitoring Status */}
            <div className="bg-blue-900 border border-blue-700 rounded-lg p-4 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center flex-shrink-0">
                  {checkingDeployment ? (
                    <div className="w-3 h-3 bg-white rounded-full animate-pulse"></div>
                  ) : (
                    <svg className="w-3 h-3 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4" />
                    </svg>
                  )}
                </div>
                <div>
                  <h4 className="text-blue-200 text-sm font-medium">
                    {deploymentComplete ? 'Deployment Complete!' : checkingDeployment ? 'Monitoring Deployment...' : 'Ready to Monitor'}
                  </h4>
                  <p className="text-blue-300 text-xs mt-1">
                    {deploymentComplete
                      ? 'Logic App successfully deployed and detected'
                      : checkingDeployment
                        ? 'Checking Azure for deployment progress every 10 seconds'
                        : 'Will automatically detect when ARM deployment completes'
                    }
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-muted rounded-lg p-4 mb-6">
              <p className="text-foreground text-sm font-medium mb-3">This will deploy:</p>
              <ul className="text-muted-foreground text-sm space-y-2">
                <li className="flex items-center gap-2">
                  {deploymentComplete ? (
                    <span className="text-green-400">OK</span>
                  ) : (
                    <span className="text-muted-foreground">o</span>
                  )}
                  Logic App (playbook) to receive Sentinel incidents
                </li>
                <li className="flex items-center gap-2">
                  {deploymentComplete ? (
                    <span className="text-green-400">OK</span>
                  ) : (
                    <span className="text-muted-foreground">o</span>
                  )}
                  Azure Key Vault for secure API key storage
                </li>
                <li className="flex items-center gap-2">
                  {automationRuleResult ? (
                    <span className="text-green-400">OK</span>
                  ) : automationRuleLoading ? (
                    <span className="text-yellow-400">...</span>
                  ) : deploymentComplete ? (
                    <span className="text-yellow-400">...</span>
                  ) : (
                    <span className="text-muted-foreground">o</span>
                  )}
                  Automation Rule to trigger on new incidents
                </li>
              </ul>
            </div>

            {automationRuleResult && (
              <div className="bg-green-900 border border-green-700 rounded-lg p-4 mb-6">
                <h4 className="text-green-200 text-sm font-medium">Setup Complete!</h4>
                <p className="text-green-300 text-xs mt-1">
                  Automation rule "{automationRuleResult.automation_rule_name}" is active.
                  New incidents will be automatically analyzed.
                </p>
              </div>
            )}

            <div className="bg-background rounded-lg p-4 mb-6">
              <p className="text-muted-foreground text-sm mb-3">Pre-configured for:</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between bg-card rounded px-3 py-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-muted-foreground text-sm">Workspace:</span>
                    <span className="text-foreground text-sm font-mono truncate">{selectedWorkspace.workspace_name}</span>
                  </div>
                  <button
                    onClick={handleCopyWorkspace}
                    className="ml-3 bg-muted hover:bg-muted text-foreground px-2 py-1 rounded text-xs flex-shrink-0 transition-colors"
                  >
                    {workspaceCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div className="flex items-center justify-between bg-card rounded px-3 py-2">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className="text-muted-foreground text-sm">Resource Group:</span>
                    <span className="text-foreground text-sm font-mono truncate">{selectedWorkspace.resource_group}</span>
                  </div>
                  <button
                    onClick={handleCopyResourceGroup}
                    className="ml-3 bg-muted hover:bg-muted text-foreground px-2 py-1 rounded text-xs flex-shrink-0 transition-colors"
                  >
                    {resourceGroupCopied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-6">
              <a
                href={deployInfo.deploy_url}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-primary hover:bg-primary/90 text-foreground font-medium py-3 px-8 rounded-lg text-center"
              >
                Deploy to Azure
              </a>
              <a
                href={deployInfo.template_url}
                target="_blank"
                rel="noopener noreferrer"
                className="bg-muted hover:bg-muted text-foreground font-medium py-3 px-8 rounded-lg text-center"
              >
                Download Template
              </a>
            </div>

            {!deploymentComplete && !automationRuleResult && (
              <div className="text-center">
                <button
                  onClick={handleCheckDeployment}
                  disabled={checkingDeployment}
                  className="bg-primary hover:bg-primary/90 text-foreground text-sm py-2 px-4 rounded disabled:opacity-50"
                >
                  {checkingDeployment ? 'Checking...' : 'Check Deployment Status'}
                </button>
              </div>
            )}

            {deploymentComplete && !automationRuleResult && !automationRuleLoading && (
              <div className="text-center">
                <button
                  onClick={handleCreateAutomationRule}
                  className="bg-green-600 hover:bg-green-700 text-foreground font-medium py-2 px-6 rounded-lg"
                >
                  Create Automation Rule
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step: Create Workspace */}
        {step === 'create-workspace' && (
          <div className="bg-card rounded-lg p-8 border border">
            <div className="flex items-center mb-6">
              <button
                onClick={() => setStep('workspace')}
                className="text-muted-foreground hover:text-foreground mr-4"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <div>
                <h2 className="text-2xl font-bold text-foreground">Create Sentinel Workspace</h2>
                <p className="text-muted-foreground">Configure your new Log Analytics workspace with Microsoft Sentinel</p>
              </div>
            </div>

            {loading && subscriptions.length === 0 ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-400 mx-auto"></div>
                <p className="mt-4 text-muted-foreground">Loading subscription data...</p>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Subscription */}
                <div>
                  <label className="block text-foreground text-sm font-medium mb-2">Azure Subscription</label>
                  <select
                    value={selectedSubscription}
                    onChange={(e) => setSelectedSubscription(e.target.value)}
                    className="w-full bg-background border border-input rounded-lg px-4 py-3 text-foreground focus:border-primary focus:outline-none"
                  >
                    {subscriptions.map((sub) => (
                      <option key={sub.subscription_id} value={sub.subscription_id}>
                        {sub.display_name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Region */}
                <div>
                  <label className="block text-foreground text-sm font-medium mb-2">Azure Region</label>
                  <select
                    value={selectedRegion}
                    onChange={(e) => setSelectedRegion(e.target.value)}
                    className="w-full bg-background border border-input rounded-lg px-4 py-3 text-foreground focus:border-primary focus:outline-none"
                  >
                    {regions.map((region) => (
                      <option key={region.name} value={region.name}>
                        {region.display_name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Resource Group Name */}
                <div>
                  <label className="block text-foreground text-sm font-medium mb-2">Resource Group Name</label>
                  <input
                    type="text"
                    value={resourceGroupName}
                    onChange={(e) => setResourceGroupName(e.target.value)}
                    placeholder="e.g., rg-sentinel-prod"
                    className="w-full bg-background border border-input rounded-lg px-4 py-3 text-foreground placeholder-gray-500 focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-muted-foreground text-xs">A new resource group will be created</p>
                </div>

                {/* Workspace Name */}
                <div>
                  <label className="block text-foreground text-sm font-medium mb-2">Workspace Name</label>
                  <input
                    type="text"
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    placeholder="e.g., sentinel-workspace"
                    className="w-full bg-background border border-input rounded-lg px-4 py-3 text-foreground placeholder-gray-500 focus:border-primary focus:outline-none"
                  />
                  <p className="mt-1 text-muted-foreground text-xs">Must be unique across Azure</p>
                </div>

                <button
                  onClick={handleCreateWorkspaceDirect}
                  disabled={loading || !resourceGroupName || !workspaceName}
                  className="w-full bg-primary hover:bg-primary/90 text-foreground font-medium py-3 px-8 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <span className="flex items-center justify-center gap-2">
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                      Creating Workspace...
                    </span>
                  ) : (
                    'Create Workspace & Continue'
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Deploy to Azure Template Popup */}
      {showDeployTemplatePopup && deployTemplateUrl && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg p-8 border border max-w-lg w-full">
            <div className="text-center">
              <div className="w-16 h-16 bg-purple-600 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-8 h-8 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-foreground mb-4">Deploy Sentinel Workspace</h3>
              <p className="text-muted-foreground mb-6">
                Click the button below to open Azure Portal with a pre-configured ARM template.
              </p>
              <div className="flex flex-col gap-3">
                <a
                  href={deployTemplateUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-primary hover:bg-primary/90 text-foreground font-medium py-3 px-6 rounded-lg inline-block"
                  onClick={() => setShowDeployTemplatePopup(false)}
                >
                  Open Azure Portal
                </a>
                <button
                  onClick={() => setShowDeployTemplatePopup(false)}
                  className="text-muted-foreground hover:text-foreground text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Managed SIEM Popup */}
      {showManagedPopup && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-lg p-8 border border max-w-md w-full">
            <div className="text-center">
              <div className="w-16 h-16 bg-green-600 rounded-full flex items-center justify-center mx-auto mb-6">
                <svg className="w-8 h-8 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold text-foreground mb-4">Managed SIEM Service</h3>
              <p className="text-muted-foreground mb-6">
                Our fully managed SIEM service is coming soon!
              </p>
              <button
                onClick={() => setShowManagedPopup(false)}
                className="bg-muted hover:bg-muted text-foreground font-medium py-2 px-6 rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="max-w-4xl mx-auto px-4 py-8 text-center text-muted-foreground text-sm">
        SOC Onboarding Portal
      </footer>
    </div>
  )
}

export default App
