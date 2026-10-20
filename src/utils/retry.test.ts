import { AxiosError, AxiosHeaders } from 'axios';
import { APIError, BadInputError, NotEnoughCreditsError } from '../errors';
import { backoffDelay, isRetryableError, parseRetryAfter, retryWithBackoff } from './retry';

const config = { maxRetries: 3, backoff: 1000, maxBackoff: 60000 };

describe('isRetryableError', () => {
  it('retries 5xx, 429 and dropped connections only', () => {
    expect(isRetryableError(new APIError('busy', 503))).toBe(true);
    expect(isRetryableError(new APIError('slow down', 429))).toBe(true);
    const dropped = new APIError('dropped');
    dropped.code = 'ECONNRESET';
    expect(isRetryableError(dropped)).toBe(true);

    expect(isRetryableError(new APIError('missing', 404))).toBe(false);
    expect(isRetryableError(new BadInputError('bad'))).toBe(false);
    expect(isRetryableError(new NotEnoughCreditsError())).toBe(false);
    expect(isRetryableError(new Error('boom'))).toBe(false);
  });

  it('reads raw axios errors', () => {
    const headers = new AxiosHeaders();
    const response = (status: number) => ({
      status,
      statusText: '',
      headers,
      config: { headers },
      data: '',
    });
    expect(isRetryableError(new AxiosError('x', 'ECONNRESET'))).toBe(true);
    expect(isRetryableError(new AxiosError('x', 'ERR_CANCELED'))).toBe(false);
    expect(
      isRetryableError(new AxiosError('x', undefined, undefined, undefined, response(502)))
    ).toBe(true);
    expect(
      isRetryableError(new AxiosError('x', undefined, undefined, undefined, response(403)))
    ).toBe(false);
  });
});

describe('backoff', () => {
  it('doubles with jitter and stops at the cap', () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const delay = backoffDelay(attempt, config);
      expect(delay).toBeGreaterThanOrEqual(1000 * 2 ** attempt);
      expect(delay).toBeLessThan(1000 * 2 ** attempt + 1000);
    }
    expect(backoffDelay(10, config)).toBe(60000);
  });

  it('follows retry-after, within the cap', () => {
    expect(backoffDelay(0, config, new APIError('x', 429, undefined, 12))).toBe(12000);
    expect(backoffDelay(0, config, new APIError('x', 429, undefined, 600))).toBe(60000);
  });

  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter(3)).toBe(3);
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    const inTenSeconds = new Date(Date.now() + 10000).toUTCString();
    expect(parseRetryAfter(inTenSeconds)).toBeGreaterThan(8);
  });
});

describe('retryWithBackoff', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries until success', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new APIError('busy', 503))
      .mockRejectedValueOnce(new APIError('busy', 502))
      .mockResolvedValue('ok');
    const result = retryWithBackoff(fn, config);
    await jest.advanceTimersByTimeAsync(10000);
    await expect(result).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that cannot pass later', async () => {
    const fn = jest.fn().mockRejectedValue(new BadInputError('bad'));
    await expect(retryWithBackoff(fn, config)).rejects.toThrow(BadInputError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('stops after maxRetries', async () => {
    const fn = jest.fn().mockRejectedValue(new APIError('busy', 503));
    const result = retryWithBackoff(fn, { ...config, maxRetries: 2 });
    result.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(60000);
    await expect(result).rejects.toThrow('busy');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
