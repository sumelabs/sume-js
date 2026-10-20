import { CredentialsMissedError } from './errors';

export interface Credentials {
  apiKey: string;
}

export function fetchCredentials(): Credentials {
  const apiKey = process.env.SUME_API_KEY?.trim();
  if (apiKey) {
    return { apiKey };
  }

  throw new CredentialsMissedError();
}
