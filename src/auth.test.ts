import { fetchCredentials } from './auth';
import { CredentialsMissedError } from './errors';

describe('fetchCredentials', () => {
  const saved = process.env.SUME_API_KEY;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.SUME_API_KEY;
    } else {
      process.env.SUME_API_KEY = saved;
    }
  });

  it('reads SUME_API_KEY', () => {
    process.env.SUME_API_KEY = '  sume_live_abc  ';
    expect(fetchCredentials()).toEqual({ apiKey: 'sume_live_abc' });
  });

  it('throws CredentialsMissedError naming the variable and where to make a key', () => {
    delete process.env.SUME_API_KEY;
    expect(() => fetchCredentials()).toThrow(CredentialsMissedError);
    expect(() => fetchCredentials()).toThrow(/SUME_API_KEY/);
    expect(() => fetchCredentials()).toThrow(/https:\/\/open\.sume\.com\/api-keys/);
  });
});
