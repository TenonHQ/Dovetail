/**
 * Google OAuth2 type definitions for Dovetail Google integrations.
 */

import { OAuth2Client } from "google-auth-library";

// --- Configuration ---

export interface GoogleAuthConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri?: string;
}

export interface GoogleAuthResult {
  auth: OAuth2Client;
  email?: string;
}

// --- Setup ---

export interface SetupConfig {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  redirectUri?: string;
}

export interface SetupResult {
  refreshToken: string;
  accessToken: string;
  email?: string;
}

// --- Error Types ---

export interface GoogleAuthError {
  code: number;
  message: string;
  context: string;
}
