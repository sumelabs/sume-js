import {
  APIError,
  AuthenticationError,
  BadInputError,
  NotEnoughCreditsError,
  SumeError,
  TimeoutError,
  ValidationError,
} from './errors';

describe('errors', () => {
  const envelope = {
    error: {
      code: 'rate_limited',
      message: 'Too many requests for this key.',
      request_id: 'req_1',
      retry_after_seconds: 7,
    },
  };

  it('APIError reads the Sume error envelope', () => {
    const error = new APIError('Too many requests for this key.', 429, envelope);
    expect(error).toBeInstanceOf(SumeError);
    expect(error.name).toBe('APIError');
    expect(error.statusCode).toBe(429);
    expect(error.code).toBe('rate_limited');
    expect(error.requestId).toBe('req_1');
    expect(error.retryAfter).toBe(7);
    expect(error.responseData).toBe(envelope);
  });

  it('a retry-after header wins over the body', () => {
    expect(new APIError('x', 429, envelope, 3).retryAfter).toBe(3);
  });

  it('typed errors keep their status and stay APIErrors', () => {
    const auth = new AuthenticationError();
    expect(auth).toBeInstanceOf(APIError);
    expect(auth.statusCode).toBe(401);
    expect(auth.message).toBe('Authentication failed');

    const credits = new NotEnoughCreditsError();
    expect(credits).toBeInstanceOf(APIError);
    expect(credits.statusCode).toBe(402);
    expect(credits.name).toBe('NotEnoughCreditsError');
    expect(credits.message).toBe('Not enough credits');
  });

  it('BadInputError and ValidationError list the failing fields', () => {
    const details = [
      { type: 'required', loc: ['prompt'], msg: 'is required' },
      { type: 'custom', loc: [], msg: 'Unrecognized key: "promt"' },
    ];
    const bad = new BadInputError(details);
    expect(bad.statusCode).toBe(400);
    expect(bad.message).toBe('prompt: is required, Unrecognized key: "promt"');
    expect(bad.details).toBe(details);

    const invalid = new ValidationError('Check the body');
    expect(invalid.statusCode).toBe(422);
    expect(invalid.message).toBe('Check the body');
    expect(new ValidationError(undefined).message).toBe('Check your input params');
  });

  it('TimeoutError carries the request id and the idempotency key', () => {
    const error = new TimeoutError('late', 'job_1', 'key_1');
    expect(error).toBeInstanceOf(SumeError);
    expect(error.requestId).toBe('job_1');
    expect(error.idempotencyKey).toBe('key_1');
  });
});
