import * as dotenv from 'dotenv';

dotenv.config();

export type ConfigMode = 'Dev' | 'Staging' | 'Prod';

export interface EnvConfig {
  mode: ConfigMode;
  instanceUrl: string;
  apiBaseUrl: string;
  email: string;
  password: string;
}

const API_BASE_PATH = '/api/v1/';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function resolveConfig(mode: ConfigMode): Omit<EnvConfig, 'mode'> {
  switch (mode) {
    case 'Dev': {
      const instanceUrl = required('E2E_DEV_INSTANCE_URL');
      return {
        instanceUrl,
        apiBaseUrl: `${instanceUrl}${API_BASE_PATH}`,
        email: required('E2E_DEV_EMAIL'),
        password: required('E2E_DEV_PASSWORD'),
      };
    }
    case 'Staging': {
      const instanceUrl = required('AP_STAGING_URL');
      return {
        instanceUrl,
        apiBaseUrl: `${instanceUrl}${API_BASE_PATH}`,
        email: required('AP_STAGING_EMAIL'),
        password: required('AP_STAGING_PASSWORD'),
      };
    }
    case 'Prod': {
      const instanceUrl = required('E2E_PROD_INSTANCE_URL');
      return {
        instanceUrl,
        apiBaseUrl: `${instanceUrl}${API_BASE_PATH}`,
        email: required('E2E_PROD_EMAIL'),
        password: required('E2E_PROD_PASSWORD'),
      };
    }
    default:
      throw new Error(`Unknown E2E_CONFIG_MODE: ${mode}`);
  }
}

const mode = (process.env.E2E_CONFIG_MODE as ConfigMode) || 'Dev';

export const env: EnvConfig = {
  mode,
  ...resolveConfig(mode),
};
