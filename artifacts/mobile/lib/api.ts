import * as SecureStore from 'expo-secure-store';
import { setBaseUrl, setAuthTokenGetter } from '@workspace/api-client-react';

/**
 * Real API wiring for the MedCreds mobile app.
 *
 * The generated API client (@workspace/api-client-react) issues requests to
 * relative paths like `/api/credentials`. On mobile we must point those at the
 * HealthDocs server and attach the bearer token issued at login.
 */

const TOKEN_KEY = 'medcreds_token';

/** Origin of the HealthDocs platform (API + web app live behind it). */
export function getApiUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : 'http://localhost:80';
}

/** Public QR verification page served by the web platform. */
export function getVerifyUrl(qrToken: string): string {
  const webBase = (
    process.env.EXPO_PUBLIC_WEB_URL ?? `${getApiUrl()}/health-docs`
  ).replace(/\/+$/, '');
  return `${webBase}/verify/${qrToken}`;
}

export async function getStoredToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function storeToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

export async function clearStoredToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/**
 * Global reaction to a rejected session (HTTP 401 mid-use): AuthContext
 * registers a handler that clears the stored token and returns the user to
 * the login screen. A registry keeps this module free of React imports.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

let configured = false;

/** Idempotent client setup — call before the first API request. */
export function configureApiClient(): void {
  if (configured) return;
  configured = true;
  setBaseUrl(getApiUrl());
  setAuthTokenGetter(() => SecureStore.getItemAsync(TOKEN_KEY));
}

/** Read a picked file (file://, content://, blob: or data: URI) as a Blob. */
export async function fileUriToBlob(uri: string): Promise<Blob> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new Error(`Could not read selected file (${response.status})`);
  }
  return response.blob();
}

/** PUT the file bytes to the presigned upload URL. */
export async function uploadFileToStorage(
  uploadURL: string,
  blob: Blob,
  contentType: string,
): Promise<void> {
  const res = await fetch(uploadURL, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status})`);
  }
}
