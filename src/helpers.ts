import { createHmac, timingSafeEqual } from 'crypto';
import { BadInputError } from './errors';
import { WebhookPayload } from './types';

export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_SIGNATURE_VERSION = 'sume-v1';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-sume-webhook-timestamp';
export const WEBHOOK_SIGNATURE_HEADER = 'x-sume-webhook-signature';

export function webhook(url: string): WebhookPayload {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new BadInputError('Webhook URL must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadInputError('Webhook URL must be an absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BadInputError('Webhook URL must use HTTPS');
  }
  return { url };
}

export function verifyWebhook(
  rawBody: string | Buffer,
  timestamp: string | string[] | undefined,
  signature: string | string[] | undefined,
  secret: string,
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS
): boolean {
  if (!secret || typeof secret !== 'string') {
    throw new BadInputError('Webhook signing secret must be a non-empty string');
  }
  const stamp = Array.isArray(timestamp) ? timestamp[0] : timestamp;
  const header = Array.isArray(signature) ? signature.join(',') : signature;
  if (!stamp || !header || !/^\d+$/.test(stamp.trim())) {
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(stamp.trim())) > toleranceSeconds) {
    return false;
  }
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = Buffer.from(
    `${WEBHOOK_SIGNATURE_VERSION}=` +
      createHmac('sha256', secret)
        .update(Buffer.concat([Buffer.from(`${stamp.trim()}.`, 'utf8'), body]))
        .digest('hex'),
    'utf8'
  );
  return header.split(',').some((entry) => {
    const actual = Buffer.from(entry.trim(), 'utf8');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
