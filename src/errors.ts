export class SumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SumeError';
  }
}

export interface ValidationErrorDetail {
  type: string;
  loc: string[];
  msg: string;
  input?: any;
  ctx?: Record<string, any>;
}

export class APIError extends SumeError {
  statusCode?: number;
  responseData?: any;
  code?: string;
  requestId?: string;
  retryAfter?: number;

  constructor(message: string, statusCode?: number, responseData?: any, retryAfter?: number) {
    super(message);
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.responseData = responseData;
    const body = responseData?.error;
    this.code = typeof body?.code === 'string' ? body.code : undefined;
    this.requestId = typeof body?.request_id === 'string' ? body.request_id : undefined;
    this.retryAfter =
      retryAfter ??
      (typeof body?.retry_after_seconds === 'number' ? body.retry_after_seconds : undefined);
  }
}

export class AuthenticationError extends APIError {
  statusCode: number = 401;

  constructor(message: string = 'Authentication failed', responseData?: any) {
    super(message, 401, responseData);
    this.name = 'AuthenticationError';
  }
}

export class CredentialsMissedError extends SumeError {
  constructor() {
    super(
      'API key not found. Set the SUME_API_KEY environment variable, or pass credentials (or apiKey) in config. Create a key at https://open.sume.com/api-keys.'
    );
    this.name = 'CredentialsMissedError';
  }
}

export class TimeoutError extends SumeError {
  requestId?: string;
  idempotencyKey?: string;

  constructor(message: string, requestId?: string, idempotencyKey?: string) {
    super(message);
    this.name = 'TimeoutError';
    this.requestId = requestId;
    this.idempotencyKey = idempotencyKey;
  }
}

export class NotEnoughCreditsError extends APIError {
  statusCode: number = 402;

  constructor(message: string = 'Not enough credits', responseData?: any) {
    super(message, 402, responseData);
    this.name = 'NotEnoughCreditsError';
  }
}

function detailMessage(detail: string | ValidationErrorDetail[] | undefined): {
  message: string;
  details?: ValidationErrorDetail[];
} {
  if (Array.isArray(detail)) {
    return {
      message: detail
        .map((err) => (err.loc.length > 0 ? `${err.loc.join('.')}: ${err.msg}` : err.msg))
        .join(', '),
      details: detail,
    };
  }
  if (typeof detail === 'string') {
    return { message: detail };
  }
  return { message: 'Check your input params' };
}

export class ValidationError extends APIError {
  statusCode: number = 422;
  details?: ValidationErrorDetail[];

  constructor(detail: string | ValidationErrorDetail[] | undefined, responseData?: any) {
    const { message, details } = detailMessage(detail);
    super(message, 422, responseData);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class BadInputError extends APIError {
  statusCode: number = 400;
  details?: ValidationErrorDetail[];

  constructor(detail: string | ValidationErrorDetail[] | undefined, responseData?: any) {
    const { message, details } = detailMessage(detail);
    super(message, 400, responseData);
    this.name = 'BadInputError';
    this.details = details;
  }
}

export class BrowserNotSupportedError extends SumeError {
  constructor() {
    super(
      'This SDK is not supported in browser environments. Please use it in a Node.js environment.'
    );
    this.name = 'BrowserNotSupportedError';
  }
}
