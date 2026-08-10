# API Testing

Playwright-based API test suite for docxster.ai. Tests hit the REST API directly (no browser) and share an authenticated session across the run.

## Setup

Install dependencies:

```bash
npm install
```

This installs everything listed in [package.json](package.json):

| Package | Purpose |
|---|---|
| `@playwright/test` | Test runner + API request client (`request` fixture) |
| `typescript` | Lets the suite be written in `.ts` |
| `@types/node` | Type defs for Node built-ins (`fs`, `path`, etc.) used in [session.ts](session.ts) |
| `dotenv` | Loads `.env` into `process.env` for [config.ts](config.ts) |

Playwright also needs its browser/runtime binaries installed once (only relevant if you ever add UI tests — API tests alone don't need a browser download, but running the install is safe either way):

```bash
npx playwright install
```

## Environment configuration

Copy your own `.env` (it's gitignored) with the variables for whichever mode you run against. Mode is picked via `E2E_CONFIG_MODE` (`Dev` | `Staging` | `Prod`, defaults to `Dev`) and read in [config.ts](config.ts):

| Mode | Required env vars |
|---|---|
| `Dev` | `E2E_DEV_INSTANCE_URL`, `E2E_DEV_EMAIL`, `E2E_DEV_PASSWORD` |
| `Staging` | `AP_STAGING_URL`, `AP_STAGING_EMAIL`, `AP_STAGING_PASSWORD` |
| `Prod` | `E2E_PROD_INSTANCE_URL`, `E2E_PROD_EMAIL`, `E2E_PROD_PASSWORD` |

`apiBaseUrl` is built automatically as `<instanceUrl>/api/v1/`.

## Running tests

```bash
npm test            # run all tests headlessly
npm run test:headed # run with browser UI (only meaningful for UI-mode debugging tools)
npm run report      # open the last HTML report
```

## How the framework fits together

```
config.ts            Reads .env, resolves the active mode, exposes `env` (baseURL, credentials)
playwright.config.ts Playwright's own config: test dir, timeout, HTML reporter, global setup, baseURL/headers
global-setup.ts       Runs once before the whole suite: logs in, saves the token/projectId to disk
session.ts            Reads/writes .auth/session.json (the persisted session from global setup)
src/auth.api.ts        Login request helper + shared types (LoginRequestBody, LoginResponse, Session)
tests/login.spec.ts     The actual test cases (successful login, invalid credentials)
tsconfig.json          TypeScript compiler options for the project
.env                    Your local secrets/environment values (not committed)
.auth/session.json      Generated at test-run time by global-setup.ts (not committed)
playwright-report/      Generated HTML report output (not committed)
test-results/           Generated raw test artifacts/traces (not committed)
```

### Flow

1. `playwright.config.ts` points `globalSetup` at [global-setup.ts](global-setup.ts).
2. Before any test file runs, `global-setup.ts` calls `login()` from [src/auth.api.ts](src/auth.api.ts) using credentials from `config.ts`, then saves the returned `token` and `projectId` via `saveSession()` in [session.ts](session.ts) — written to `.auth/session.json`.
3. Individual specs (e.g. [tests/login.spec.ts](tests/login.spec.ts)) can call `login()` again directly, or `loadSession()` to reuse the token saved in step 2 instead of re-authenticating.
4. Playwright's HTML reporter writes results to `playwright-report/`, and per-test traces to `test-results/`.

## Adding new tests

Add new `*.spec.ts` files under [tests/](tests/). For endpoints that need auth, either call `login()` per-test or `loadSession()` to reuse the session token saved by global setup — see [tests/login.spec.ts](tests/login.spec.ts) for the pattern.
