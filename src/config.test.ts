import { Config } from './config';

describe('Config', () => {
  it('uses the Open API host by default while allowing overrides', () => {
    expect(new Config().baseURL).toBe('https://api.open.sume.com');
    expect(new Config({ baseURL: 'https://custom.example' }).baseURL).toBe(
      'https://custom.example'
    );
  });

  it('keeps the Higgsfield client defaults', () => {
    const config = new Config();
    expect(config.timeout).toBe(120000);
    expect(config.maxRetries).toBe(3);
    expect(config.retryBackoff).toBe(1000);
    expect(config.retryMaxBackoff).toBe(60000);
    expect(config.pollInterval).toBe(2000);
    expect(config.maxPollTime).toBe(300000);
    expect(config.headers).toEqual({});
  });

  it('keeps a default when a value is undefined and ignores unknown keys', () => {
    const config = new Config({
      timeout: undefined,
      baseURL: undefined,
      credentials: 'sume_live_x',
    } as never);
    expect(config.timeout).toBe(120000);
    expect(config.baseURL).toBe('https://api.open.sume.com');
    expect(config).not.toHaveProperty('credentials');
  });

  it.each([
    [{ timeout: 0 }, 'timeout must be positive'],
    [{ maxRetries: -1 }, 'maxRetries must be non-negative'],
    [{ maxRetries: 6 }, 'maxRetries cannot be greater than 5'],
    [{ retryBackoff: -1 }, 'retryBackoff must be non-negative'],
    [{ pollInterval: 0 }, 'pollInterval must be positive'],
    [{ maxPollTime: Number.NaN }, 'maxPollTime must be positive'],
    [{ baseURL: 'api.open.sume.com' }, 'baseURL must be an absolute URL'],
    [{ baseURL: 'ftp://api.open.sume.com' }, 'baseURL must be an http(s) URL'],
  ])('refuses %p', (config, message) => {
    expect(() => new Config(config)).toThrow(message);
  });
});
