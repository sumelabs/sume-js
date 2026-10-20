import { createHmac } from 'crypto';
import { BadInputError } from './errors';
import { verifyWebhook, webhook } from './helpers';

describe('webhook', () => {
  it('returns the webhook for a public HTTPS URL', () => {
    expect(webhook('https://example.com/hooks/sume')).toEqual({
      url: 'https://example.com/hooks/sume',
    });
  });

  it.each(['', '   ', 'example.com/hook', 'http://example.com/hook'])('refuses %p', (url) => {
    expect(() => webhook(url)).toThrow(BadInputError);
  });
});

describe('verifyWebhook', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({
    event: 'job.completed',
    request_id: 'job_1',
    job_id: 'job_1',
    status: 'OK',
    payload: { artifacts: [] },
  });

  function sign(key: string, timestamp: number, payload = body) {
    return `sume-v1=${createHmac('sha256', key).update(`${timestamp}.${payload}`).digest('hex')}`;
  }

  const now = () => Math.floor(Date.now() / 1000);

  it('accepts a delivery signed with the secret', () => {
    const t = now();
    expect(verifyWebhook(body, String(t), sign(secret, t), secret)).toBe(true);
    expect(verifyWebhook(Buffer.from(body), [String(t)], [sign(secret, t)], secret)).toBe(true);
  });

  it('accepts any live secret during a rotation', () => {
    const t = now();
    const header = `${sign('whsec_new', t)}, ${sign(secret, t)}`;
    expect(verifyWebhook(body, String(t), header, secret)).toBe(true);
  });

  it('refuses a wrong secret, a changed body and a missing header', () => {
    const t = now();
    expect(verifyWebhook(body, String(t), sign('whsec_other', t), secret)).toBe(false);
    expect(verifyWebhook(`${body} `, String(t), sign(secret, t), secret)).toBe(false);
    expect(verifyWebhook(body, undefined, sign(secret, t), secret)).toBe(false);
    expect(verifyWebhook(body, String(t), undefined, secret)).toBe(false);
  });

  it('refuses an entry without the sume-v1 prefix', () => {
    const t = now();
    const bare = sign(secret, t).replace('sume-v1=', '');
    expect(verifyWebhook(body, String(t), bare, secret)).toBe(false);
  });

  it('refuses a delivery older than five minutes', () => {
    const t = now() - 301;
    expect(verifyWebhook(body, String(t), sign(secret, t), secret)).toBe(false);
    expect(verifyWebhook(body, String(t), sign(secret, t), secret, 600)).toBe(true);
  });

  it('needs a secret', () => {
    expect(() => verifyWebhook(body, '1', 'sume-v1=00', '')).toThrow(BadInputError);
  });
});
