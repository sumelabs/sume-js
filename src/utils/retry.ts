import axios from 'axios';
import { APIError } from '../errors';

export interface RetryConfig {
  maxRetries: number;
  backoff: number;
  maxBackoff: number;
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
]);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? seconds : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof APIError) {
    if (error.statusCode === undefined) {
      return RETRYABLE_NETWORK_CODES.has(error.code ?? '');
    }
    return error.statusCode === 429 || error.statusCode >= 500;
  }
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return error.response.status === 429 || error.response.status >= 500;
    }
    return RETRYABLE_NETWORK_CODES.has(error.code ?? '');
  }
  return false;
}

export function retryAfterMs(error: unknown): number | undefined {
  if (error instanceof APIError) {
    return error.retryAfter === undefined ? undefined : error.retryAfter * 1000;
  }
  if (axios.isAxiosError(error)) {
    const seconds = parseRetryAfter(error.response?.headers?.['retry-after']);
    return seconds === undefined ? undefined : seconds * 1000;
  }
  return undefined;
}

export function backoffDelay(attempt: number, config: RetryConfig, error?: unknown): number {
  const hinted = retryAfterMs(error);
  if (hinted !== undefined) {
    return Math.min(hinted, config.maxBackoff);
  }
  return Math.min(config.backoff * Math.pow(2, attempt) + Math.random() * 1000, config.maxBackoff);
}

export async function retryWithBackoff<T>(fn: () => Promise<T>, config: RetryConfig): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= config.maxRetries || !isRetryableError(error)) {
        throw error;
      }
      await sleep(backoffDelay(attempt, config, error));
    }
  }
}
