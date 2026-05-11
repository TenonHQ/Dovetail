# @tenonhq/dovetail-google-auth

Google OAuth2 authentication for Dovetail Google integrations. Shared auth layer used by `@tenonhq/dovetail-gmail` and `@tenonhq/dovetail-google-calendar`.

## Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click **New Project** and name it (e.g., "Tenon CTO Automation")
3. Select the project

### 2. Enable APIs

1. Go to **APIs & Services > Library**
2. Search for and enable:
   - **Gmail API**
   - **Google Calendar API**

### 3. Create OAuth Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. If prompted, configure the **OAuth consent screen** first:
   - User type: **Internal** (Google Workspace) or **External**
   - App name: "Tenon CTO Automation"
   - Scopes: `gmail.modify`, `calendar`
4. Application type: **Desktop app** (or **Web application**)
5. If using Web application, add `http://localhost:3000/callback` as an **Authorized redirect URI**
6. Download or copy the **Client ID** and **Client Secret**

### 4. Get a Refresh Token

```bash
# Set your credentials
export GOOGLE_CLIENT_ID="your-client-id"
export GOOGLE_CLIENT_SECRET="your-client-secret"

# Run the setup script
cd packages/google-auth
npm run setup
```

This opens your browser for Google authorization. After granting access, the refresh token is printed to the terminal.

### 5. Add to .env

```bash
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REFRESH_TOKEN=your-refresh-token
```

## Usage

```typescript
import { createGoogleAuth, configFromEnv } from "@tenonhq/dovetail-google-auth";

// Load config from environment variables
var config = configFromEnv();

// Create authenticated client
var { auth } = createGoogleAuth({ config: config });

// Pass auth to Gmail or Calendar packages
```

## Token Expiration

Google refresh tokens expire after **7 days** for apps in "Testing" status.

To get long-lived tokens:
- **Google Workspace accounts:** Set the app consent screen to **Internal**
- **Personal accounts:** Set the app to **In production** (requires verification for sensitive scopes, or keep under 100 users for unverified apps)

If your token expires, run `npm run setup` again to get a new one.

## API

### `createGoogleAuth({ config })`

Creates an OAuth2Client with a refresh token. Token refresh is handled automatically.

### `configFromEnv()`

Reads `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN` from `process.env`.

### `handleAuthError(error, context)`

Standardized error handler for Google API errors. Maps HTTP status codes (401, 403, 429) to actionable error messages.
