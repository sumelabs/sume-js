import {
  createSumeClient,
  configure as configureClient,
  V2ClientConfig,
  SumeClient,
  SubscribeOptions,
  SubscribeInput,
} from './client';

export const sume = createSumeClient(undefined);

export function config(config: V2ClientConfig): void {
  configureClient(config);
}

export { configureClient as configure, createSumeClient };
export type { V2ClientConfig, SumeClient, SubscribeOptions, SubscribeInput };
export type { ClientConfig } from '../config';
export { DEFAULT_BASE_URL } from '../config';
export { VERSION } from '../version';

export * from '../types';
export * from '../errors';
export * from '../helpers';
export * from './types';
