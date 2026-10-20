export interface ClientConfig {
  timeout?: number;
  maxRetries?: number;
  retryBackoff?: number;
  retryMaxBackoff?: number;
  pollInterval?: number;
  maxPollTime?: number;
  headers?: Record<string, string>;
  baseURL?: string;
}

export const DEFAULT_BASE_URL = 'https://api.open.sume.com';

const CONFIG_KEYS = [
  'timeout',
  'maxRetries',
  'retryBackoff',
  'retryMaxBackoff',
  'pollInterval',
  'maxPollTime',
  'headers',
  'baseURL',
] as const;

export class Config implements ClientConfig {
  timeout: number = 120000;
  maxRetries: number = 3;
  retryBackoff: number = 1000;
  retryMaxBackoff: number = 60000;
  pollInterval: number = 2000;
  maxPollTime: number = 300000;
  headers: Record<string, string> = {};
  baseURL: string = DEFAULT_BASE_URL;

  constructor(config?: Partial<ClientConfig>) {
    if (config) {
      for (const key of CONFIG_KEYS) {
        if (config[key] !== undefined) {
          Object.assign(this, { [key]: config[key] });
        }
      }
      this.headers = { ...this.headers };
    }
    this.validate();
  }

  private validate(): void {
    if (!(this.timeout > 0)) {
      throw new Error('timeout must be positive');
    }
    if (!(this.maxRetries >= 0)) {
      throw new Error('maxRetries must be non-negative');
    }
    if (this.maxRetries > 5) {
      throw new Error('maxRetries cannot be greater than 5');
    }
    if (!(this.retryBackoff >= 0)) {
      throw new Error('retryBackoff must be non-negative');
    }
    if (!(this.retryMaxBackoff >= 0)) {
      throw new Error('retryMaxBackoff must be non-negative');
    }
    if (!(this.pollInterval > 0)) {
      throw new Error('pollInterval must be positive');
    }
    if (!(this.maxPollTime > 0)) {
      throw new Error('maxPollTime must be positive');
    }
    let url: URL;
    try {
      url = new URL(this.baseURL);
    } catch {
      throw new Error('baseURL must be an absolute URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('baseURL must be an http(s) URL');
    }
  }
}
