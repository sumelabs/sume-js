import axios, { AxiosError, AxiosHeaders, AxiosResponse, InternalAxiosRequestConfig } from 'axios';

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  baseURL?: string;
  headers: AxiosHeaders;
  body: any;
  rawData: unknown;
  timeout?: number;
  at: number;
}

export type Reply =
  { status: number; data?: unknown; headers?: Record<string, string> } | { networkError: string };

export type Route = Reply | Reply[] | ((request: RecordedRequest) => Reply);

export const JOB_ID = 'job_7513b52d-3669-4ffe-b317-8b02000715eb';
export const BASE = 'https://api.open.sume.com';

export function submitted(overrides: Record<string, unknown> = {}, jobId = JOB_ID) {
  return {
    data: {
      request_id: jobId,
      job: {
        id: jobId,
        type: 'image_generation',
        status: 'queued',
        model: 'gpt-image-2',
        idempotency_key: 'key',
        communication_mode: 'async',
        result: null,
        error: null,
      },
      status_url: `${BASE}/v1/jobs/${jobId}/status`,
      result_url: `${BASE}/v1/jobs/${jobId}/result`,
      events_url: `${BASE}/v1/jobs/${jobId}/events`,
      cancel_url: null,
      cancelable: false,
      next_action: 'poll_status',
      next_poll_after_seconds: 2,
      recommended_poll_interval_seconds: 2,
      result_ready: false,
      terminal: false,
      idempotency_hit: false,
      ...overrides,
    },
  };
}

const QUEUE_STATUS: Record<string, string> = {
  queued: 'IN_QUEUE',
  processing: 'IN_PROGRESS',
  completed: 'COMPLETED',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

export function statusBody(
  sumeStatus: 'queued' | 'processing' | 'completed' | 'failed' | 'canceled',
  overrides: Record<string, unknown> = {},
  jobId = JOB_ID
) {
  const terminal = ['completed', 'failed', 'canceled'].includes(sumeStatus);
  return {
    data: {
      request_id: jobId,
      job_id: jobId,
      status: QUEUE_STATUS[sumeStatus],
      sume_status: sumeStatus,
      status_url: `${BASE}/v1/jobs/${jobId}/status`,
      result_url: `${BASE}/v1/jobs/${jobId}/result`,
      events_url: `${BASE}/v1/jobs/${jobId}/events`,
      cancel_url: sumeStatus === 'queued' ? `${BASE}/v1/jobs/${jobId}/cancel` : null,
      cancelable: sumeStatus === 'queued',
      next_action:
        sumeStatus === 'completed' ? 'fetch_result' : terminal ? 'inspect_events' : 'poll_status',
      next_poll_after_seconds: terminal ? null : 2,
      recommended_poll_interval_seconds: terminal ? null : 2,
      result_ready: sumeStatus === 'completed',
      terminal,
      job: {
        id: jobId,
        status: sumeStatus,
        error: null,
      },
      ...overrides,
    },
  };
}

export function artifact(type: 'image' | 'video' | 'audio', n = 1) {
  const ext = type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'mp3';
  const contentType =
    type === 'image' ? 'image/png' : type === 'video' ? 'video/mp4' : 'audio/mpeg';
  return {
    id: `artf_${type}${n}`,
    type,
    url: `https://media.sume.com/artifacts/artf_${type}${n}/out.${ext}`,
    content_type: contentType,
    public_artifact_id: `artf_${type}${n}`,
    visibility: 'public_by_link',
    size_bytes: null,
    width: null,
    height: null,
    duration_ms: null,
    checksum_sha256: null,
  };
}

export function resultBody(artifacts: unknown[], jobId = JOB_ID) {
  return {
    data: {
      request_id: jobId,
      job_id: jobId,
      status: 'COMPLETED',
      result: { artifacts },
    },
  };
}

export function errorBody(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  requestId = 'req_0ee311b4334e4b118a94c7d1c48577fd'
) {
  return {
    error: {
      code,
      message,
      request_id: requestId,
      category: 'validation',
      stage: 'validation',
      retryable: false,
      retry_after_seconds: null,
      public_reason: code,
      next_action: 'fix_input',
      ...extra,
    },
  };
}

function pathOf(config: InternalAxiosRequestConfig): { url: string; path: string } {
  const raw = config.url ?? '';
  if (/^https?:\/\//.test(raw)) {
    const parsed = new URL(raw);
    return { url: raw, path: `${parsed.origin}${parsed.pathname}` };
  }
  const base = (config.baseURL ?? '').replace(/\/+$/, '');
  const url = `${base}${raw.startsWith('/') ? raw : `/${raw}`}`;
  return { url, path: new URL(url).pathname };
}

export function mockSumeApi(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];
  const cursors = new Map<string, number>();
  const realCreate = axios.create.bind(axios);

  jest.spyOn(axios, 'create').mockImplementation((options) => {
    const client = realCreate(options);
    client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const { url, path } = pathOf(config);
      const method = (config.method ?? 'get').toUpperCase();
      let body: any = config.data;
      if (typeof config.data === 'string') {
        try {
          body = JSON.parse(config.data);
        } catch {
          body = config.data;
        }
      }
      const request: RecordedRequest = {
        method,
        url,
        path,
        baseURL: config.baseURL,
        headers: AxiosHeaders.from(config.headers),
        body,
        rawData: config.data,
        timeout: config.timeout,
        at: Date.now(),
      };
      requests.push(request);

      const key = `${method} ${path}`;
      const route = routes[key];
      if (route === undefined) {
        throw new Error(`Unexpected request: ${key}`);
      }
      let reply: Reply;
      if (typeof route === 'function') {
        reply = route(request);
      } else if (Array.isArray(route)) {
        const index = cursors.get(key) ?? 0;
        cursors.set(key, index + 1);
        reply = route[Math.min(index, route.length - 1)];
      } else {
        reply = route;
      }

      if ('networkError' in reply) {
        throw new AxiosError('socket hang up', reply.networkError, config);
      }
      const response: AxiosResponse = {
        data: reply.data,
        status: reply.status,
        statusText: String(reply.status),
        headers: new AxiosHeaders(reply.headers ?? {}),
        config,
        request: {},
      };
      if (reply.status >= 400) {
        throw new AxiosError(
          `Request failed with status code ${reply.status}`,
          reply.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
          config,
          {},
          response
        );
      }
      return response;
    };
    return client;
  });

  return { requests };
}

export async function settle<T>(promise: Promise<T>, stepMs = 1000, maxSteps = 2000): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => undefined);
  for (let i = 0; i < maxSteps && !done; i++) {
    await jest.advanceTimersByTimeAsync(stepMs);
  }
  return tracked;
}
