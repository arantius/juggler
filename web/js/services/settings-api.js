//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The REST calls the settings panel and its tabs make, one function per
 * endpoint, so a view states what it wants rather than how to ask for it.
 *
 * Every JSON call goes through {@link fetchJson} and keeps its failure policy:
 * a function throws an {@link import('./http.js').HttpError} on a non-OK
 * response unless its {@link RequestPolicy} carries a `fallback`, in which case
 * it resolves to that instead. `errorPrefix` prefixes the thrown message, as it
 * does there. A policy is passed through as given, so a `fallback` of
 * `undefined` still counts as one.
 * @module services/settings-api
 */

import { fetchJson } from './http.js';
import { apiUrl } from '../utils/api-url.js';

/**
 * How a call reports a failure — the failure-policy half of fetchJson's options.
 * @typedef {object} RequestPolicy
 * @property {string} [errorPrefix] - Translated prefix for the thrown message (or the warning, with a fallback).
 * @property {any} [fallback] - Resolve to this on failure instead of throwing.
 */

/**
 * The model chosen for a role (default, cheap, decision), as the server reports it.
 * @typedef {object} ModelChoice
 * @property {string} [provider] - Provider name; empty for Automatic.
 * @property {string} [model] - Model id; empty for Automatic.
 * @property {string} [thinking] - Reasoning level; empty for the model's default.
 * @property {string} [serviceTier] - Serving tier; empty for standard.
 * @property {boolean} [explicit] - False when the server chooses (Automatic).
 * @property {boolean} [disabled] - Cheap model only: the user wants none.
 * @property {boolean} [available] - Decision model only: whether it can serve now.
 * @property {{provider: string, model: string}} [autoResolved] - Cheap model only: what Automatic resolved to.
 */

/**
 * The default model as GET /api/default-model reports it: provider and model
 * are always present, both empty while the server chooses (Automatic).
 * @typedef {ModelChoice & {provider: string, model: string}} DefaultModelChoice
 */

/**
 * The answer a provider sign-in endpoint gives: `success` false carries `error`.
 * @typedef {{success?: boolean, error?: string, [field: string]: any}} SuccessEnvelope
 */

// ── /api/config (credentials.json) ─────────────────────────────────────────

/**
 * GET /api/config: the stored configuration (which keys exist, provider hosts,
 * the background-job switches).
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The config object.
 */
export function getConfig(policy = {}) {
  return fetchJson(apiUrl('/config'), { ...policy });
}

/**
 * PUT /api/config with one key. The server merges a PUT into what is stored,
 * so every other key keeps its value; an empty string clears a stored key.
 * @param {string} key - The wire name (snake_case), e.g. `auto_name_disabled`.
 * @param {any} value - The value to store.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The server's answer (usually nothing).
 */
export function setConfig(key, value, policy = {}) {
  return fetchJson(apiUrl('/config'), { method: 'PUT', body: { [key]: value }, ...policy });
}

/**
 * POST /api/config/provider-enabled: switch a keyless or sign-in provider on or
 * off. The server queues a provider recompute, whose providers-update reaches
 * every model selector.
 * @param {string} provider - Provider name.
 * @param {boolean} enabled
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The server's answer.
 */
export function setProviderEnabled(provider, enabled, policy = {}) {
  return fetchJson(apiUrl('/config/provider-enabled'), {
    method: 'POST',
    body: { provider, enabled },
    ...policy,
  });
}

// ── /api/settings (settings.json) ──────────────────────────────────────────

/**
 * PUT /api/settings with a partial document. The server merges it section by
 * section and answers with the whole document as stored.
 * @param {object} patch - The sections to change, e.g. `{updates: {mode}}`.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The settings document after the write.
 */
export function updateSettings(patch, policy = {}) {
  return fetchJson(apiUrl('/settings'), { method: 'PUT', body: patch, ...policy });
}

// ── Providers ──────────────────────────────────────────────────────────────

/**
 * GET /api/providers: the published provider catalogue. `ready` is false while
 * the server's first refresh is still running.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{providers?: any[], ready?: boolean}>} The catalogue payload.
 */
export function getProviders(policy = {}) {
  return fetchJson(apiUrl('/providers'), { ...policy });
}

/**
 * GET /api/providers/copilot/host: the GitHub host Copilot signs in against.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<SuccessEnvelope|null>} `{success, host}`.
 */
export function getCopilotHost(policy = {}) {
  return fetchJson(apiUrl('/providers/copilot/host'), { ...policy });
}

/**
 * POST /api/providers/copilot/host: store the GitHub host.
 * @param {string} host - e.g. `github.com`.
 * @returns {Promise<SuccessEnvelope|null>} `{success}` or `{success: false, error}`.
 */
export function setCopilotHost(host) {
  return fetchJson(apiUrl('/providers/copilot/host'), { method: 'POST', body: { host } });
}

/**
 * POST /api/providers/copilot/device/start: begin a GitHub device-code sign-in.
 * @param {string} host - GitHub host to sign in against.
 * @returns {Promise<SuccessEnvelope|null>} `{success, userCode, verificationUri, deviceCode, interval}`.
 */
export function startCopilotDeviceLogin(host) {
  return fetchJson(apiUrl('/providers/copilot/device/start'), { method: 'POST', body: { host } });
}

/**
 * POST /api/providers/copilot/device/poll: ask whether the device code was authorized.
 * @param {string} deviceCode - From {@link startCopilotDeviceLogin}.
 * @param {string} host - The host the flow was started against.
 * @returns {Promise<SuccessEnvelope|null>} `{success, status}`; status is authorized, pending, slow_down, expired or denied.
 */
export function pollCopilotDeviceLogin(deviceCode, host) {
  return fetchJson(apiUrl('/providers/copilot/device/poll'), {
    method: 'POST',
    body: { deviceCode, host },
  });
}

/**
 * POST /api/providers/copilot/signout: forget the GitHub login Juggler stored.
 * @returns {Promise<SuccessEnvelope|null>} `{success}` or `{success: false, error}`.
 */
export function signOutCopilot() {
  return fetchJson(apiUrl('/providers/copilot/signout'), { method: 'POST' });
}

// ── Model roles ────────────────────────────────────────────────────────────

/**
 * GET /api/default-model: the model new conversations start on.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<DefaultModelChoice>} The choice.
 */
export function getDefaultModel(policy = {}) {
  return fetchJson(apiUrl('/default-model'), { ...policy });
}

/**
 * PUT /api/default-model. An empty provider/model returns it to Automatic.
 * @param {ModelChoice} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setDefaultModel(choice) {
  return fetchJson(apiUrl('/default-model'), { method: 'PUT', body: choice });
}

/**
 * GET /api/cheap-model: the model background jobs spend.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<ModelChoice|null>} The choice.
 */
export function getCheapModel(policy = {}) {
  return fetchJson(apiUrl('/cheap-model'), { ...policy });
}

/**
 * PUT /api/cheap-model. `disabled: true` means none; an empty provider/model
 * returns it to Automatic.
 * @param {ModelChoice} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setCheapModel(choice) {
  return fetchJson(apiUrl('/cheap-model'), { method: 'PUT', body: choice });
}

/**
 * GET /api/decision-model: the model that answers yes/no questions with probabilities.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<ModelChoice|null>} The choice.
 */
export function getDecisionModel(policy = {}) {
  return fetchJson(apiUrl('/decision-model'), { ...policy });
}

/**
 * PUT /api/decision-model. An empty provider/model clears it.
 * @param {{provider: string, model: string}} choice
 * @returns {Promise<any>} The server's answer.
 */
export function setDecisionModel(choice) {
  return fetchJson(apiUrl('/decision-model'), { method: 'PUT', body: choice });
}

// ── Connectivity ───────────────────────────────────────────────────────────

/**
 * GET /api/connectivity: LAN/WAN state and the connected clients.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The connectivity state.
 */
export function getConnectivity(policy = {}) {
  return fetchJson(apiUrl('/connectivity'), { ...policy });
}

/**
 * POST /api/connectivity/lan: open or close LAN access.
 * @param {boolean} enabled
 * @returns {Promise<any>} The server's answer.
 */
export function setLANEnabled(enabled) {
  return fetchJson(apiUrl('/connectivity/lan'), { method: 'POST', body: { enabled } });
}

/**
 * POST /api/connectivity/tunnel: start a WAN tunnel in `mode`, or stop the active one.
 * @param {{enabled: true, mode: string}|{enabled: false}} request
 * @returns {Promise<SuccessEnvelope|null>} `{success}` or `{success: false, error}`.
 */
export function setTunnel(request) {
  return fetchJson(apiUrl('/connectivity/tunnel'), { method: 'POST', body: request });
}

/**
 * GET /api/connectivity/qr: a QR code for `url`, as SVG markup. The answer is
 * markup, not JSON, so this reads the text itself; a refusal or a dead link
 * resolves to null rather than throwing, since a missing QR code is never an
 * error the user needs to hear about.
 * @param {string} url - The URL to encode.
 * @returns {Promise<string|null>} The SVG markup, or null.
 */
export async function getConnectivityQRSvg(url) {
  try {
    const res = await fetch(apiUrl(`/connectivity/qr?url=${encodeURIComponent(url)}`));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Updates ────────────────────────────────────────────────────────────────

/**
 * GET /api/update-status: this build's version and the latest one known.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<any>} The update status.
 */
export function getUpdateStatus(policy = {}) {
  return fetchJson(apiUrl('/update-status'), { ...policy });
}

/**
 * POST /api/update-status/check: check the update server now.
 * @returns {Promise<any>} The fresh update status; `error` is set when the server could not be reached.
 */
export function checkForUpdate() {
  return fetchJson(apiUrl('/update-status/check'), { method: 'POST' });
}

// ── Logs ───────────────────────────────────────────────────────────────────

/**
 * GET /api/logs: this session's log files.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{files?: any[]}|null>} The file list.
 */
export function listLogs(policy = {}) {
  return fetchJson(apiUrl('/logs'), { ...policy });
}

/**
 * GET /api/logs/content: one log file from `offset` on.
 * @param {string} path - Absolute path of the log file.
 * @param {number} offset - Byte offset to read from.
 * @param {RequestPolicy} [policy]
 * @returns {Promise<{content: string, replaced?: boolean, [field: string]: any}|null>} The content read.
 */
export function getLogContent(path, offset, policy = {}) {
  return fetchJson(apiUrl(`/logs/content?path=${encodeURIComponent(path)}&offset=${offset}`), { ...policy });
}
