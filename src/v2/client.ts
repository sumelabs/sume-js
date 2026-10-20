import axios, { AxiosError, AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import { Config, ClientConfig } from '../config';
import { fetchCredentials, Credentials } from '../auth';
import {
  APIError,
  AuthenticationError,
  BadInputError,
  NotEnoughCreditsError,
  ValidationError,
  ValidationErrorDetail,
  CredentialsMissedError,
  BrowserNotSupportedError,
  TimeoutError,
} from '../errors';
import {
  isRetryableError,
  parseRetryAfter,
  retryAfterMs,
  retryWithBackoff,
  RetryConfig,
  sleep,
} from '../utils/retry';
import { Artifact, JobError, UploadResponse } from '../types';
import { VERSION } from '../version';
import { EndpointInputMap, V2RequestStatus, V2Response } from './types';

export interface V2ClientConfig extends ClientConfig {
  credentials?: string;
  apiKey?: string;
}

export interface SubscribeOptions<TInput = Record<string, unknown>> {
  input: TInput;
  webhook?: {
    url: string;
  };
  withPolling?: boolean;
  idempotencyKey?: string;
}

export type SubscribeInput<TEndpoint extends string> = TEndpoint extends keyof EndpointInputMap
  ? EndpointInputMap[TEndpoint]
  : Record<string, unknown>;

export interface SumeClient {
  subscribe<TEndpoint extends string>(
    endpoint: TEndpoint,
    options: SubscribeOptions<SubscribeInput<TEndpoint>>
  ): Promise<V2Response>;

  upload(data: Buffer | Uint8Array, contentType: string): Promise<string>;

  uploadImage(imageBuffer: Buffer | Uint8Array, format?: 'jpeg' | 'png' | 'webp'): Promise<string>;

  configure(config: V2ClientConfig): void;
}

interface ClientState {
  config?: Config;
  client?: AxiosInstance;
  credentials?: Credentials;
}

type JobPayload = Record<string, any>;

const globalState: ClientState = {};

const TERMINAL_STATUSES: ReadonlySet<V2RequestStatus> = new Set([
  'completed',
  'failed',
  'canceled',
]);

const IDEMPOTENCY_KEY = /^[\x20-\x7E]{1,255}$/;

function checkBrowserEnvironment(): void {
  const isBrowser = typeof (globalThis as any).window !== 'undefined';
  if (isBrowser) {
    throw new BrowserNotSupportedError();
  }
}

function parseApiKey(value: string): string {
  const key = value.trim();
  if (key === '' || /\s|:/.test(key)) {
    throw new BadInputError(
      'Credentials must be one Sume API key ("sume_live_..."), not "KEY_ID:KEY_SECRET"'
    );
  }
  return key;
}

function validationDetail(body: any): ValidationErrorDetail[] | undefined {
  const errors = body?.details?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  return errors.map((err: any) => ({
    type: String(err?.type ?? 'invalid'),
    loc: Array.isArray(err?.loc)
      ? err.loc.map(String)
      : typeof err?.path === 'string' && err.path !== ''
        ? err.path.split('.')
        : [],
    msg: String(err?.message ?? err?.msg ?? 'Invalid value'),
  }));
}

function mapAPIError(error: AxiosError<any>): never {
  const response = error.response;
  if (!response) {
    const wrapped = new APIError(`Request to the Sume API failed: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  }
  const data = response.data;
  const body = data && typeof data === 'object' ? data.error : undefined;
  const message =
    typeof body?.message === 'string' && body.message !== '' ? body.message : error.message;

  if (response.status === 401) {
    throw new AuthenticationError(message, data);
  } else if (response.status === 402) {
    throw new NotEnoughCreditsError(message, data);
  } else if (response.status === 422) {
    throw new ValidationError(validationDetail(body) ?? message, data);
  } else if (response.status === 400) {
    throw new BadInputError(validationDetail(body) ?? message, data);
  }
  throw new APIError(
    message,
    response.status,
    data,
    parseRetryAfter(response.headers?.['retry-after'])
  );
}

function mapStorageError(error: AxiosError): never {
  const status = error.response?.status;
  const wrapped = new APIError(
    status
      ? `Upload to storage failed with status ${status}`
      : `Upload to storage failed: ${error.message}`,
    status,
    undefined,
    parseRetryAfter(error.response?.headers?.['retry-after'])
  );
  if (!status) {
    wrapped.code = error.code;
  }
  throw wrapped;
}

function initializeClient(config?: V2ClientConfig): {
  config: Config;
  client: AxiosInstance;
  credentials: Credentials;
} {
  checkBrowserEnvironment();

  let apiKey: string | undefined;
  if (config?.credentials) {
    apiKey = parseApiKey(config.credentials);
  } else if (config?.apiKey) {
    apiKey = parseApiKey(config.apiKey);
  }

  const cfg = new Config(config);

  let creds: Credentials;
  if (apiKey) {
    creds = { apiKey };
  } else {
    try {
      creds = fetchCredentials();
    } catch {
      creds = { apiKey: '' };
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (typeof process !== 'undefined' && process.versions?.node) {
    headers['User-Agent'] = `sume-server-js/${VERSION}`;
  }
  Object.assign(headers, cfg.headers);

  const axiosClient = axios.create({
    baseURL: cfg.baseURL,
    timeout: cfg.timeout,
    headers,
  });
  axiosClient.interceptors.response.use((response) => response, mapAPIError);

  return { config: cfg, client: axiosClient, credentials: creds };
}

function retryConfig(config: Config): RetryConfig {
  return {
    maxRetries: config.maxRetries,
    backoff: config.retryBackoff,
    maxBackoff: config.retryMaxBackoff,
  };
}

function unwrap(body: any): JobPayload {
  return body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body;
}

function requestIdOf(payload: JobPayload): string {
  const id = payload?.request_id ?? payload?.job_id ?? payload?.job?.id;
  if (typeof id !== 'string' || id === '') {
    throw new APIError('The Sume API answered without a request id', undefined, payload);
  }
  return id;
}

function statusOf(payload: JobPayload): V2RequestStatus {
  const raw = payload?.sume_status ?? payload?.job?.status ?? payload?.status;
  switch (String(raw ?? '').toLowerCase()) {
    case 'queued':
    case 'in_queue':
      return 'queued';
    case 'processing':
    case 'in_progress':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return payload?.terminal === true ? 'failed' : 'in_progress';
  }
}

function isTerminal(payload: JobPayload): boolean {
  return payload?.terminal === true || TERMINAL_STATUSES.has(statusOf(payload));
}

function jobPath(requestId: string, suffix = ''): string {
  return `/v1/jobs/${encodeURIComponent(requestId)}${suffix}`;
}

function jobUrl(config: Config, requestId: string, suffix: string): string {
  return `${config.baseURL.replace(/\/+$/, '')}${jobPath(requestId, suffix)}`;
}

function nextPollDelay(config: Config, payload: JobPayload): number {
  const hint = Number(payload?.next_poll_after_seconds);
  return Math.max(config.pollInterval, Number.isFinite(hint) && hint > 0 ? hint * 1000 : 0);
}

function toV2Response(
  config: Config,
  payload: JobPayload,
  artifacts?: Artifact[],
  error?: JobError | null
): V2Response {
  const requestId = requestIdOf(payload);
  const response: V2Response = {
    status: statusOf(payload),
    request_id: requestId,
    status_url: payload.status_url ?? jobUrl(config, requestId, '/status'),
    cancel_url: payload.cancel_url ?? null,
    result_url: payload.result_url ?? jobUrl(config, requestId, '/result'),
  };
  if (artifacts) {
    const images = artifacts.filter((a) => a.type === 'image').map((a) => ({ url: a.url }));
    const video = artifacts.find((a) => a.type === 'video');
    if (images.length > 0) {
      response.images = images;
    }
    if (video) {
      response.video = { url: video.url };
    }
    response.artifacts = artifacts;
  }
  if (error !== undefined) {
    response.error = error;
  }
  return response;
}

async function pollV2Request(
  client: AxiosInstance,
  config: Config,
  submitted: JobPayload,
  idempotencyKey: string
): Promise<JobPayload> {
  const requestId = requestIdOf(submitted);
  const pollingUrl = jobPath(requestId, '/status');
  const deadline = Date.now() + config.maxPollTime;
  let delay = nextPollDelay(config, submitted);

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new TimeoutError(
        `Polling exceeded maximum time of ${config.maxPollTime}ms for request ${requestId}. ` +
          `The job keeps running: call subscribe again with idempotencyKey "${idempotencyKey}" to keep waiting for it.`,
        requestId,
        idempotencyKey
      );
    }
    await sleep(Math.min(delay, remaining));

    try {
      const response = await client.get(pollingUrl);
      const payload = unwrap(response.data);
      if (isTerminal(payload)) {
        return payload;
      }
      delay = nextPollDelay(config, payload);
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }
      delay = Math.max(config.pollInterval, retryAfterMs(error) ?? 0);
    }
  }
}

async function finishRequest(
  client: AxiosInstance,
  config: Config,
  payload: JobPayload
): Promise<V2Response> {
  const requestId = requestIdOf(payload);

  if (statusOf(payload) === 'completed') {
    const response = await retryWithBackoff(
      () => client.get(jobPath(requestId, '/result')),
      retryConfig(config)
    );
    const artifacts = unwrap(response.data)?.result?.artifacts;
    return toV2Response(config, payload, Array.isArray(artifacts) ? artifacts : []);
  }

  let error: JobError | null | undefined =
    payload.job && typeof payload.job === 'object' && 'error' in payload.job
      ? payload.job.error
      : payload.error;
  if (error === undefined) {
    const response = await retryWithBackoff(
      () => client.get(jobPath(requestId)),
      retryConfig(config)
    );
    error = unwrap(response.data)?.job?.error ?? null;
  }
  return toV2Response(config, payload, undefined, error);
}

function toBuffer(data: Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new BadInputError('Upload data must be a Buffer or Uint8Array');
}

export function createSumeClient(config?: V2ClientConfig): SumeClient {
  const state: ClientState = config ? initializeClient(config) : globalState;

  function ensureInitialized(): void {
    checkBrowserEnvironment();
    if (!state.client || !state.credentials?.apiKey) {
      const initialized = initializeClient(state.config);
      if (!initialized.credentials.apiKey) {
        throw new CredentialsMissedError();
      }
      Object.assign(state, initialized);
    }
  }

  async function upload(data: Buffer | Uint8Array, contentType: string): Promise<string> {
    ensureInitialized();
    const client = state.client!;
    const clientConfig = state.config!;

    if (typeof contentType !== 'string' || contentType.trim() === '') {
      throw new BadInputError('Content type must be a MIME type, such as "image/png"');
    }
    const bytes = toBuffer(data);

    const linkResponse = await retryWithBackoff(
      () =>
        client.post('/v1/files/generate-upload-url', {
          content_type: contentType,
          size_bytes: bytes.byteLength,
        }),
      retryConfig(clientConfig)
    );
    const link = unwrap(linkResponse.data) as UploadResponse;

    const storage = axios.create();
    storage.interceptors.response.use((response) => response, mapStorageError);
    await retryWithBackoff(
      () =>
        storage.request({
          method: link.upload_method || 'PUT',
          url: link.upload_url,
          data: bytes,
          headers: link.upload_headers ?? { 'Content-Type': link.content_type ?? contentType },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: clientConfig.timeout,
        }),
      retryConfig(clientConfig)
    );

    return link.public_url;
  }

  return {
    async subscribe<TEndpoint extends string>(
      endpoint: TEndpoint,
      options: SubscribeOptions<SubscribeInput<TEndpoint>>
    ): Promise<V2Response> {
      ensureInitialized();
      const client = state.client!;
      const clientConfig = state.config!;

      if (typeof endpoint !== 'string' || !endpoint.includes('/')) {
        throw new BadInputError(
          `"${endpoint}" is not an endpoint. Send the model in the input instead: ` +
            `subscribe('/v1/image-router/generate', { input: { model: '${endpoint}', ... } }), ` +
            `or '/v1/video-router/generate' for video.`
        );
      }
      if (!options || typeof options.input !== 'object' || options.input === null) {
        throw new BadInputError('options.input must be an object');
      }

      const { input, webhook, withPolling = true } = options;
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new BadInputError('idempotencyKey must be 1 to 255 printable ASCII characters');
      }

      const formattedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

      const requestBody: Record<string, unknown> = { ...input };
      if (webhook) {
        requestBody.mode = 'webhook';
        requestBody.webhook_url = webhook.url;
      }

      const response = await retryWithBackoff(
        () =>
          client.post(formattedEndpoint, requestBody, {
            headers: { 'Idempotency-Key': idempotencyKey },
          }),
        retryConfig(clientConfig)
      );

      let payload = unwrap(response.data);
      if (!isTerminal(payload)) {
        if (!withPolling) {
          return toV2Response(clientConfig, payload);
        }
        payload = await pollV2Request(client, clientConfig, payload, idempotencyKey);
      }

      return finishRequest(client, clientConfig, payload);
    },

    upload,

    async uploadImage(
      imageBuffer: Buffer | Uint8Array,
      format: 'jpeg' | 'png' | 'webp' = 'jpeg'
    ): Promise<string> {
      return upload(imageBuffer, `image/${format}`);
    },

    configure(config: V2ClientConfig): void {
      checkBrowserEnvironment();

      Object.assign(state, initializeClient(config));
    },
  };
}

export function configure(config: V2ClientConfig): void {
  Object.assign(globalState, initializeClient(config));
}

export function reset(): void {
  globalState.config = undefined;
  globalState.client = undefined;
  globalState.credentials = undefined;
}
