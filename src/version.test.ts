import { readFileSync } from 'fs';
import { join } from 'path';
import { VERSION } from './version';

describe('VERSION', () => {
  it('matches package.json, which the User-Agent reports', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});
