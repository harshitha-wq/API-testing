import type { APIRequestContext } from '@playwright/test';
import { env } from '../config';

export type LoginRequestBody = {
  email: string;
  password: string;
};

export type LoginResponse = {
  token: string;
  projectId: string;
  [key: string]: unknown;
};

export type Session = {
  token: string;
  projectId: string;
};

const SIGN_IN_ENDPOINT = 'authentication/sign-in';

export function login(
  request: APIRequestContext,
  body: LoginRequestBody = { email: env.email, password: env.password },
) {
  return request.post(SIGN_IN_ENDPOINT, { data: body });
}
