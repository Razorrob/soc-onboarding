import type { Configuration } from '@azure/msal-browser';
import { LogLevel } from '@azure/msal-browser';

// Multi-tenant MSAL configuration - allows any Azure AD tenant to sign in
export const msalConfig: Configuration = {
  auth: {
    clientId: 'c6b3223d-983e-42bb-8d0d-22ed3831aac9', // SOC T0 SaaS Integration (multi-tenant)
    authority: 'https://login.microsoftonline.com/organizations', // Allow any organization
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: {
    cacheLocation: 'sessionStorage',
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message, containsPii) => {
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error(message);
            break;
          case LogLevel.Warning:
            console.warn(message);
            break;
          case LogLevel.Info:
            console.info(message);
            break;
          case LogLevel.Verbose:
            console.debug(message);
            break;
        }
      },
      logLevel: LogLevel.Warning,
    },
  },
};

// Request ARM API access for listing workspaces
export const loginRequest = {
  scopes: [
    'https://management.azure.com/user_impersonation',
    'openid',
    'profile',
    'email'
  ],
  prompt: 'consent' as const // Force admin consent
};
