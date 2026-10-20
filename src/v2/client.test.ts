import { inspect } from 'util';
import { createSumeClient, configure, reset } from './client';
import { config, sume } from './index';
import {
  APIError,
  AuthenticationError,
  BadInputError,
  BrowserNotSupportedError,
  CredentialsMissedError,
  NotEnoughCreditsError,
  TimeoutError,
} from '../errors';
import { VERSION } from '../version';
import {
  BASE,
  JOB_ID,
  artifact,
  errorBody,
  mockSumeApi,
  resultBody,
  settle,
  statusBody,
  submitted,
} from '../test-utils/mock-api';

const KEY = 'sume_live_testkey0000000000000000000000000000';
const IMAGE = '/v1/image-router/generate';
const VIDEO = '/v1/video-router/generate';
const STATUS = `GET /v1/jobs/${JOB_ID}/status`;
const RESULT = `GET /v1/jobs/${JOB_ID}/result`;
const JOB = `GET /v1/jobs/${JOB_ID}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const savedEnv = process.env.SUME_API_KEY;

beforeEach(() => {
  reset();
  delete process.env.SUME_API_KEY;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  reset();
  if (savedEnv === undefined) {
    delete process.env.SUME_API_KEY;
  } else {
    process.env.SUME_API_KEY = savedEnv;
  }
});

function withWindow(run: () => void) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'window', original);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
}

describe('Configuration', () => {
  it('creates a client with a credentials string', () => {
    const client = createSumeClient({ credentials: KEY });

    expect(typeof client.subscribe).toBe('function');
    expect(typeof client.upload).toBe('function');
    expect(typeof client.uploadImage).toBe('function');
    expect(typeof client.configure).toBe('function');
  });

  it('creates a client with apiKey', () => {
    expect(createSumeClient({ apiKey: KEY })).toBeDefined();
  });

  it.each(['key-id:key-secret', 'sume live key', '   '])(
    'refuses credentials that are not one Sume key: %p',
    (credentials) => {
      expect(() => createSumeClient({ credentials })).toThrow(BadInputError);
    }
  );

  it('refuses an invalid config value', () => {
    expect(() => createSumeClient({ credentials: KEY, maxRetries: 6 })).toThrow(
      'maxRetries cannot be greater than 5'
    );
  });

  it('throws BrowserNotSupportedError in a browser environment', () => {
    withWindow(() => {
      expect(() => createSumeClient({ credentials: KEY })).toThrow(BrowserNotSupportedError);
      expect(() => configure({ credentials: KEY })).toThrow(BrowserNotSupportedError);
    });
  });

  it('rejects the browser even after initialization', async () => {
    const client = createSumeClient({ credentials: KEY });
    const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
    try {
      await expect(client.subscribe(IMAGE, { input: { model: 'm', prompt: 'p' } })).rejects.toThrow(
        BrowserNotSupportedError
      );
    } finally {
      if (original) Object.defineProperty(globalThis, 'window', original);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('throws CredentialsMissedError on first use when no key is set', async () => {
    const { requests } = mockSumeApi({});
    await expect(sume.subscribe(IMAGE, { input: { model: 'm', prompt: 'p' } })).rejects.toThrow(
      CredentialsMissedError
    );
    expect(requests).toHaveLength(0);
  });

  it('reads SUME_API_KEY lazily, after the client was created', async () => {
    const client = createSumeClient({ baseURL: 'https://lazy.test' });
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    process.env.SUME_API_KEY = KEY;
    await client.subscribe(IMAGE, {
      input: { model: 'gpt-image-2', prompt: 'p' },
      withPolling: false,
    });
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(requests[0].baseURL).toBe('https://lazy.test');
  });
});

describe('subscribe', () => {
  it('submits, polls the status, fetches the result and returns images', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: [
        { status: 200, data: statusBody('queued') },
        { status: 200, data: statusBody('processing') },
        { status: 200, data: statusBody('completed') },
      ],
      [RESULT]: { status: 200, data: resultBody([artifact('image', 1), artifact('image', 2)]) },
    });
    config({ credentials: KEY });

    const response = await settle(
      sume.subscribe(IMAGE, {
        input: {
          model: 'gpt-image-2',
          prompt: 'A ceramic coffee cup on a wooden table',
          quality: 'low',
          aspect_ratio: '1:1',
        },
      })
    );

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${IMAGE}`,
      STATUS,
      STATUS,
      STATUS,
      RESULT,
    ]);
    const submit = requests[0];
    expect(submit.url).toBe(`${BASE}${IMAGE}`);
    expect(submit.body).toEqual({
      model: 'gpt-image-2',
      prompt: 'A ceramic coffee cup on a wooden table',
      quality: 'low',
      aspect_ratio: '1:1',
    });
    expect(submit.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(submit.headers.get('Content-Type')).toBe('application/json');
    expect(submit.headers.get('User-Agent')).toBe(`sume-server-js/${VERSION}`);
    expect(submit.headers.get('Idempotency-Key')).toMatch(UUID);
    expect(submit.timeout).toBe(120000);
    for (const poll of requests.slice(1)) {
      expect(poll.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
      expect(poll.headers.get('Idempotency-Key')).toBeUndefined();
    }

    expect(response).toEqual({
      status: 'completed',
      request_id: JOB_ID,
      status_url: `${BASE}/v1/jobs/${JOB_ID}/status`,
      cancel_url: null,
      result_url: `${BASE}/v1/jobs/${JOB_ID}/result`,
      images: [{ url: artifact('image', 1).url }, { url: artifact('image', 2).url }],
      artifacts: [artifact('image', 1), artifact('image', 2)],
    });
  });

  it('accepts an endpoint without the leading slash', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    const client = createSumeClient({ credentials: KEY });
    await client.subscribe('v1/image-router/generate', {
      input: { model: 'gpt-image-2', prompt: 'p' },
      withPolling: false,
    });
    expect(requests[0].path).toBe(IMAGE);
  });

  it('refuses a bare model id as the endpoint, before any request', async () => {
    const { requests } = mockSumeApi({});
    const client = createSumeClient({ credentials: KEY });
    await expect(client.subscribe('gpt-image-2', { input: { prompt: 'p' } })).rejects.toThrow(
      /Send the model in the input instead/
    );
    expect(requests).toHaveLength(0);
  });

  it('returns the queued job at once with withPolling: false', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await client.subscribe(IMAGE, {
      input: { model: 'gpt-image-2', prompt: 'p' },
      withPolling: false,
    });
    expect(requests).toHaveLength(1);
    expect(response).toEqual({
      status: 'queued',
      request_id: JOB_ID,
      status_url: `${BASE}/v1/jobs/${JOB_ID}/status`,
      cancel_url: null,
      result_url: `${BASE}/v1/jobs/${JOB_ID}/result`,
    });
  });

  it('sends a webhook as mode "webhook" and webhook_url in the body', async () => {
    const { requests } = mockSumeApi({
      [`POST ${VIDEO}`]: { status: 202, data: submitted() },
    });
    const client = createSumeClient({ credentials: KEY });
    await client.subscribe(VIDEO, {
      input: { model: 'seedance-2.5', prompt: 'p', duration: 5 },
      webhook: { url: 'https://example.com/hooks/sume' },
      withPolling: false,
    });
    expect(requests[0].body).toEqual({
      model: 'seedance-2.5',
      prompt: 'p',
      duration: 5,
      mode: 'webhook',
      webhook_url: 'https://example.com/hooks/sume',
    });
    expect(requests[0].url).toBe(`${BASE}${VIDEO}`);
  });

  it('returns the video of a video job', async () => {
    mockSumeApi({
      [`POST ${VIDEO}`]: { status: 202, data: submitted() },
      [STATUS]: { status: 200, data: statusBody('completed') },
      [RESULT]: { status: 200, data: resultBody([artifact('video')]) },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(VIDEO, { input: { model: 'seedance-2.5', prompt: 'p', duration: 5 } })
    );
    expect(response.status).toBe('completed');
    expect(response.video).toEqual({ url: artifact('video').url });
    expect(response.images).toBeUndefined();
  });

  it('uses the given idempotencyKey, and a replay of a finished job needs no polling', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: {
        status: 200,
        data: submitted({
          job: { id: JOB_ID, status: 'completed', error: null },
          next_action: 'fetch_result',
          next_poll_after_seconds: null,
          terminal: true,
          result_ready: true,
          idempotency_hit: true,
        }),
      },
      [RESULT]: { status: 200, data: resultBody([artifact('image')]) },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await client.subscribe(IMAGE, {
      input: { model: 'gpt-image-2', prompt: 'p' },
      idempotencyKey: 'order-42',
      withPolling: false,
    });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${IMAGE}`, RESULT]);
    expect(requests[0].headers.get('Idempotency-Key')).toBe('order-42');
    expect(response.status).toBe('completed');
    expect(response.images).toEqual([{ url: artifact('image').url }]);
  });

  it('refuses an idempotencyKey Sume would refuse', async () => {
    const client = createSumeClient({ credentials: KEY });
    await expect(
      client.subscribe(IMAGE, { input: { model: 'm', prompt: 'p' }, idempotencyKey: 'é' })
    ).rejects.toThrow(BadInputError);
    await expect(
      client.subscribe(IMAGE, {
        input: { model: 'm', prompt: 'p' },
        idempotencyKey: 'x'.repeat(256),
      })
    ).rejects.toThrow(BadInputError);
  });

  it('resolves a failed job with its error instead of throwing', async () => {
    const jobError = {
      code: 'provider_content_rejected',
      message: 'The model refused this prompt.',
      category: 'provider',
      stage: 'generation_processing',
      retryable: false,
      retry_after_seconds: null,
      public_reason: 'provider_content_rejected',
      next_action: 'fix_input',
    };
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: {
        status: 200,
        data: statusBody('failed', { job: { id: JOB_ID, status: 'failed', error: jobError } }),
      },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
    );
    expect(response.status).toBe('failed');
    expect(response.error).toEqual(jobError);
    expect(response.images).toBeUndefined();
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${IMAGE}`, STATUS]);
  });

  it('reads the job for the error when the status has none', async () => {
    const jobError = { code: 'provider_failed', message: 'Generation failed.' };
    const status = statusBody('failed');
    delete (status.data as Record<string, unknown>).job;
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: { status: 200, data: status },
      [JOB]: { status: 200, data: { data: { job: { id: JOB_ID, error: jobError } } } },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
    );
    expect(response.error).toEqual(jobError);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([`POST ${IMAGE}`, STATUS, JOB]);
  });

  it('resolves a canceled job', async () => {
    mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: {
        status: 200,
        data: statusBody('canceled', {
          job: { id: JOB_ID, status: 'canceled', error: null },
        }),
      },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
    );
    expect(response.status).toBe('canceled');
    expect(response.error).toBeNull();
  });
});

describe('polling', () => {
  it('waits next_poll_after_seconds between polls, never less than pollInterval', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted({ next_poll_after_seconds: 2 }) },
      [STATUS]: [
        { status: 200, data: statusBody('queued', { next_poll_after_seconds: 7 }) },
        { status: 200, data: statusBody('processing', { next_poll_after_seconds: 1 }) },
        { status: 200, data: statusBody('completed') },
      ],
      [RESULT]: { status: 200, data: resultBody([artifact('image')]) },
    });
    const client = createSumeClient({ credentials: KEY, pollInterval: 3000 });
    await settle(client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } }), 100);

    const at = requests.map((r) => r.at);
    expect(at[1] - at[0]).toBe(3000);
    expect(at[2] - at[1]).toBe(7000);
    expect(at[3] - at[2]).toBe(3000);
  });

  it('keeps polling through 5xx, 429 and network errors', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: [
        { status: 503, data: errorBody('database_busy', 'Busy.') },
        {
          status: 429,
          data: errorBody('rate_limited', 'Slow down.'),
          headers: { 'retry-after': '9' },
        },
        { networkError: 'ECONNRESET' },
        { status: 200, data: statusBody('completed') },
      ],
      [RESULT]: { status: 200, data: resultBody([artifact('image')]) },
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } }),
      100
    );
    expect(response.status).toBe('completed');
    const polls = requests.filter((r) => r.method === 'GET' && r.path.endsWith('/status'));
    expect(polls).toHaveLength(4);
    expect(polls[2].at - polls[1].at).toBe(9000);
  });

  it('stops on an error that polling cannot fix', async () => {
    mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
      [STATUS]: { status: 404, data: errorBody('not_found', 'API job was not found.') },
    });
    const client = createSumeClient({ credentials: KEY });
    await expect(
      settle(client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } }))
    ).rejects.toMatchObject({ name: 'APIError', statusCode: 404, code: 'not_found' });
  });

  it('throws TimeoutError after maxPollTime, and the same idempotencyKey resumes the job', async () => {
    const { requests } = mockSumeApi({
      [`POST ${VIDEO}`]: { status: 202, data: submitted() },
      [STATUS]: { status: 200, data: statusBody('processing') },
    });
    const client = createSumeClient({ credentials: KEY, maxPollTime: 10000 });
    const input = { model: 'seedance-2.5', prompt: 'p', duration: 5 };

    let caught: unknown;
    try {
      await settle(client.subscribe(VIDEO, { input }), 500);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TimeoutError);
    const timeout = caught as TimeoutError;
    expect(timeout.message).toMatch(/Polling exceeded maximum time of 10000ms/);
    expect(timeout.requestId).toBe(JOB_ID);
    expect(timeout.idempotencyKey).toMatch(UUID);
    expect(timeout.message).toContain(timeout.idempotencyKey);
    const polls = requests.filter((r) => r.path.endsWith('/status'));
    expect(polls.length).toBe(5);
    expect(polls[polls.length - 1].at - requests[0].at).toBeLessThanOrEqual(10000);

    await expect(
      settle(client.subscribe(VIDEO, { input, idempotencyKey: timeout.idempotencyKey }), 500)
    ).rejects.toThrow(TimeoutError);
    const submits = requests.filter((r) => r.method === 'POST');
    expect(submits[1].headers.get('Idempotency-Key')).toBe(timeout.idempotencyKey);
    expect(submits[1].body).toEqual(submits[0].body);
  });
});

describe('retries and errors', () => {
  it('retries a submit after a 5xx with the same Idempotency-Key', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: [
        { status: 503, data: errorBody('database_busy', 'Busy.') },
        { networkError: 'ECONNRESET' },
        { status: 202, data: submitted() },
      ],
    });
    const client = createSumeClient({ credentials: KEY });
    const response = await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' }, withPolling: false })
    );
    expect(response.status).toBe('queued');
    expect(requests).toHaveLength(3);
    const keys = new Set(requests.map((r) => r.headers.get('Idempotency-Key')));
    expect(keys.size).toBe(1);
  });

  it('waits retry-after on a 429 before resubmitting', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: [
        {
          status: 429,
          data: errorBody('rate_limited', 'Too many requests.', { retry_after_seconds: 12 }),
          headers: { 'retry-after': '12' },
        },
        { status: 202, data: submitted() },
      ],
    });
    const client = createSumeClient({ credentials: KEY });
    await settle(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' }, withPolling: false }),
      100
    );
    expect(requests[1].at - requests[0].at).toBe(12000);
  });

  it('gives up after maxRetries', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 500, data: errorBody('internal_error', 'A fault on our side.') },
    });
    const client = createSumeClient({ credentials: KEY, maxRetries: 2 });
    await expect(
      settle(client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } }))
    ).rejects.toMatchObject({ name: 'APIError', statusCode: 500, code: 'internal_error' });
    expect(requests).toHaveLength(3);
  });

  it('maps 400 invalid_request to BadInputError with the field errors, without retrying', async () => {
    const body = errorBody('invalid_request', 'Invalid request body.', {
      details: {
        errors: [
          {
            path: 'prompt',
            loc: ['prompt'],
            message: "must have required property 'prompt'",
            type: 'required',
          },
          {
            path: 'image_size.width',
            loc: ['image_size', 'width'],
            message: 'must be >= 64',
            type: 'too_small',
          },
        ],
      },
    });
    const { requests } = mockSumeApi({ [`POST ${IMAGE}`]: { status: 400, data: body } });
    const client = createSumeClient({ credentials: KEY });

    const error = await client
      .subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: '' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadInputError);
    expect(error).toBeInstanceOf(APIError);
    expect(error.message).toBe(
      "prompt: must have required property 'prompt', image_size.width: must be >= 64"
    );
    expect(error.details).toEqual([
      { type: 'required', loc: ['prompt'], msg: "must have required property 'prompt'" },
      { type: 'too_small', loc: ['image_size', 'width'], msg: 'must be >= 64' },
    ]);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('invalid_request');
    expect(error.requestId).toBe('req_0ee311b4334e4b118a94c7d1c48577fd');
    expect(error.responseData).toEqual(body);
    expect(requests).toHaveLength(1);
  });

  it('maps 400 concurrency_limit_reached to BadInputError with its code', async () => {
    mockSumeApi({
      [`POST ${IMAGE}`]: {
        status: 400,
        data: errorBody(
          'concurrency_limit_reached',
          'Maximum number of concurrent requests (4) has been reached'
        ),
      },
    });
    const client = createSumeClient({ credentials: KEY });
    await expect(
      client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
    ).rejects.toMatchObject({
      name: 'BadInputError',
      code: 'concurrency_limit_reached',
      message: 'Maximum number of concurrent requests (4) has been reached',
    });
  });

  it('maps 402 insufficient_funds to NotEnoughCreditsError', async () => {
    const body = errorBody(
      'insufficient_funds',
      'Your open.sume.com balance does not cover this request. Add funds at open.sume.com/billing.',
      { details: { required_usd: '0.2890', available_usd: '0.0100' } }
    );
    const { requests } = mockSumeApi({ [`POST ${VIDEO}`]: { status: 402, data: body } });
    const client = createSumeClient({ credentials: KEY });
    const error = await client
      .subscribe(VIDEO, { input: { model: 'seedance-2.5', prompt: 'p' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NotEnoughCreditsError);
    expect(error.statusCode).toBe(402);
    expect(error.code).toBe('insufficient_funds');
    expect(error.message).toMatch(/balance does not cover this request/);
    expect(error.responseData.error.details).toEqual({
      required_usd: '0.2890',
      available_usd: '0.0100',
    });
    expect(requests).toHaveLength(1);
  });

  it('maps 401 to AuthenticationError, without retrying', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: {
        status: 401,
        data: errorBody('unauthorized', 'Missing or invalid API key.'),
      },
    });
    const client = createSumeClient({ credentials: KEY });
    const request = client.subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } });
    await expect(request).rejects.toBeInstanceOf(AuthenticationError);
    await expect(request).rejects.toMatchObject({
      name: 'AuthenticationError',
      statusCode: 401,
      code: 'unauthorized',
      message: 'Missing or invalid API key.',
    });
    expect(requests).toHaveLength(1);
  });

  it('maps other statuses to APIError with the Sume code', async () => {
    mockSumeApi({
      [`POST ${IMAGE}`]: {
        status: 403,
        data: errorBody(
          'open_key_route_not_allowed',
          'This key is an open.sume.com key: it calls the model API (Video Router, Image Router, jobs) only.'
        ),
      },
    });
    const client = createSumeClient({ credentials: KEY });
    const error = await client
      .subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(NotEnoughCreditsError);
    expect(error.code).toBe('open_key_route_not_allowed');
  });

  it('keeps the API key out of network errors', async () => {
    mockSumeApi({ [`POST ${IMAGE}`]: { networkError: 'ENOTFOUND' } });
    const client = createSumeClient({ credentials: KEY, maxRetries: 0 });
    const error = await client
      .subscribe(IMAGE, { input: { model: 'gpt-image-2', prompt: 'p' } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(APIError);
    expect(error.code).toBe('ENOTFOUND');
    expect(error.statusCode).toBeUndefined();
    expect(inspect(error, { depth: 10 })).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
  });
});

describe('clients', () => {
  it('preserve custom headers, host and timeout', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    const client = createSumeClient({
      credentials: KEY,
      baseURL: 'https://open-api.test',
      timeout: 4321,
      headers: { 'X-Example': 'preserved' },
    });
    await client.subscribe(IMAGE, {
      input: { model: 'gpt-image-2', prompt: 'p' },
      withPolling: false,
    });
    expect(requests[0].url).toBe(`https://open-api.test${IMAGE}`);
    expect(requests[0].timeout).toBe(4321);
    expect(requests[0].headers.get('X-Example')).toBe('preserved');
  });

  it('keep account keys apart from each other and from the singleton', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    const first = createSumeClient({ credentials: 'sume_live_one', baseURL: 'https://one.test' });
    const second = createSumeClient({ credentials: 'sume_live_two', baseURL: 'https://two.test' });
    config({ credentials: 'sume_live_global' });
    const input = { input: { model: 'gpt-image-2', prompt: 'p' }, withPolling: false };
    await first.subscribe(IMAGE, input);
    await second.subscribe(IMAGE, input);
    await sume.subscribe(IMAGE, input);
    expect(requests.map((r) => r.headers.get('Authorization'))).toEqual([
      'Bearer sume_live_one',
      'Bearer sume_live_two',
      'Bearer sume_live_global',
    ]);
    expect(requests.map((r) => r.baseURL)).toEqual(['https://one.test', 'https://two.test', BASE]);
  });

  it('configure() replaces the key of that client only', async () => {
    const { requests } = mockSumeApi({
      [`POST ${IMAGE}`]: { status: 202, data: submitted() },
    });
    const client = createSumeClient({ credentials: 'sume_live_old' });
    config({ credentials: 'sume_live_global_old' });
    client.configure({ credentials: 'sume_live_new', baseURL: 'https://new.test' });
    config({ credentials: 'sume_live_global_new' });
    const input = { input: { model: 'gpt-image-2', prompt: 'p' }, withPolling: false };
    await client.subscribe(IMAGE, input);
    await sume.subscribe(IMAGE, input);
    expect(requests.map((r) => r.headers.get('Authorization'))).toEqual([
      'Bearer sume_live_new',
      'Bearer sume_live_global_new',
    ]);
    expect(requests[0].baseURL).toBe('https://new.test');
  });
});

describe('upload', () => {
  const link = {
    data: {
      public_url: 'https://media.sume.com/assets/asset_1/source.png',
      upload_url: 'https://bucket.r2.test/upload?X-Amz-Signature=secret-signature',
      upload_method: 'PUT',
      upload_headers: { 'content-type': 'image/png', 'content-length': '5' },
      content_type: 'image/png',
      expires_at: '2026-10-18T16:14:37.491Z',
      asset_id: 'asset_1',
    },
  };

  it('asks for an upload URL, PUTs the bytes without the API key and returns public_url', async () => {
    const { requests } = mockSumeApi({
      'POST /v1/files/generate-upload-url': { status: 201, data: link },
      'PUT https://bucket.r2.test/upload': { status: 200 },
    });
    const client = createSumeClient({ credentials: KEY });
    const url = await client.upload(Buffer.from('hello'), 'image/png');

    expect(url).toBe('https://media.sume.com/assets/asset_1/source.png');
    expect(requests[0].url).toBe(`${BASE}/v1/files/generate-upload-url`);
    expect(requests[0].body).toEqual({ content_type: 'image/png', size_bytes: 5 });
    expect(requests[0].headers.get('Authorization')).toBe(`Bearer ${KEY}`);

    const put = requests[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(link.data.upload_url);
    expect(put.headers.get('Authorization')).toBeUndefined();
    expect(put.headers.get('content-type')).toBe('image/png');
    expect(put.headers.get('content-length')).toBe('5');
    expect(Buffer.from(put.rawData as Buffer).toString()).toBe('hello');
  });

  it('sends exactly the bytes of a Uint8Array view', async () => {
    const { requests } = mockSumeApi({
      'POST /v1/files/generate-upload-url': { status: 201, data: link },
      'PUT https://bucket.r2.test/upload': { status: 200 },
    });
    const backing = Buffer.from('xxhelloyy');
    const view = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);
    const client = createSumeClient({ credentials: KEY });
    await client.upload(view, 'image/png');
    expect(requests[0].body.size_bytes).toBe(5);
    expect(Buffer.from(requests[1].rawData as Buffer).toString()).toBe('hello');
  });

  it('uploadImage sends image/<format>, jpeg by default', async () => {
    const { requests } = mockSumeApi({
      'POST /v1/files/generate-upload-url': { status: 201, data: link },
      'PUT https://bucket.r2.test/upload': { status: 200 },
    });
    const client = createSumeClient({ credentials: KEY });
    await client.uploadImage(Buffer.from('hello'));
    await client.uploadImage(Buffer.from('hello'), 'webp');
    const asks = requests.filter((r) => r.method === 'POST');
    expect(asks.map((r) => r.body.content_type)).toEqual(['image/jpeg', 'image/webp']);
  });

  it('retries the storage PUT on a 5xx and never puts the signed URL in the error', async () => {
    const { requests } = mockSumeApi({
      'POST /v1/files/generate-upload-url': { status: 201, data: link },
      'PUT https://bucket.r2.test/upload': [{ status: 503 }, { status: 403 }],
    });
    const client = createSumeClient({ credentials: KEY });
    const error = await settle(client.upload(Buffer.from('hello'), 'image/png')).catch((e) => e);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
    expect(error).toBeInstanceOf(APIError);
    expect(error.statusCode).toBe(403);
    expect(error.message).toBe('Upload to storage failed with status 403');
    expect(inspect(error, { depth: 10 })).not.toContain('secret-signature');
  });

  it('refuses data that is not bytes', async () => {
    const client = createSumeClient({ credentials: KEY });
    await expect(client.upload('hello' as unknown as Buffer, 'image/png')).rejects.toThrow(
      BadInputError
    );
    await expect(client.upload(Buffer.from('x'), '')).rejects.toThrow(BadInputError);
  });
});

describe('types', () => {
  it('type the input of the known endpoints', () => {
    const client = createSumeClient({ credentials: KEY });
    const typed = () => {
      client.subscribe('/v1/image-router/generate', {
        input: { model: 'gpt-image-2', prompt: 'p', num_images: 2, output_format: 'webp' },
      });
      client.subscribe('/v1/video-router/generate', {
        input: { model: 'kling-3', image_url: 'https://example.com/a.png', duration: 5 },
      });
      // @ts-expect-error
      client.subscribe('/v1/image-router/generate', { input: { model: 'gpt-image-2' } });
      // @ts-expect-error
      client.subscribe('/v1/video-router/generate', { input: { prompt: 'p' } });
      client.subscribe('/v1/image-router/generate', {
        // @ts-expect-error
        input: { model: 'gpt-image-2', prompt: 'p', num_images: '2' },
      });
    };
    expect(typeof typed).toBe('function');
  });
});
