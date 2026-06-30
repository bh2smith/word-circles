"use client";

import type { SignResult, Transaction } from "@aboutcircles/miniapp-sdk";

/**
 * Standalone "Login with Circles" connector — the host side of the `crc-signin`
 * bridge. When the app runs as a plain website (not embedded in the Circles
 * host app) it embeds the connector iframe and speaks the same postMessage
 * protocol the miniapp SDK uses, only with the direction reversed: we are the
 * parent and the connector is the child.
 *
 * Protocol (connector ⇄ host):
 *   connector → crc_bridge_ready          host → request_address
 *   connector → wallet_connected {address}
 *   host → disconnect                     connector → wallet_disconnected
 *   host → send_transactions {requestId, transactions}
 *   connector → tx_success {requestId, hashes} | tx_rejected {requestId}
 *   host → sign_message {requestId, message, signatureType}
 *   connector → sign_success {requestId, signature, verified} | sign_rejected {requestId}
 *
 * Passkeys are bound to the gnosis.io relying-party id, so the connector must be
 * served from there; the embedding site can be any HTTPS origin (or localhost).
 */

const CONNECTOR_ORIGIN = "https://circles.gnosis.io";
const FRAME_SRC = `${CONNECTOR_ORIGIN}/crc-signin`;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

let frame: HTMLIFrameElement | null = null;
let backdrop: HTMLElement | null = null;
let bridgeReady = false;
let address: string | null = null;
let requestCounter = 0;

const pending: Record<string, Pending> = {};
const listeners = new Set<(address: string | null) => void>();

/** Messages buffered until the connector signals `crc_bridge_ready`. */
let outbox: unknown[] = [];

/** Resolver for an in-flight connect(), settled by wallet_connected or a dismissal. */
let connectResolve: ((address: string | null) => void) | null = null;

export function onConnectorWalletChange(
  fn: (address: string | null) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getConnectorAddress(): string | null {
  return address;
}

function emit(next: string | null): void {
  address = next;
  for (const fn of listeners) fn(next);
}

function ensureFrame(): void {
  if (frame) return;

  backdrop = document.createElement("div");
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-label", "Login with Circles");
  backdrop.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:9999",
    "display:none",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
    "background:rgba(0,0,0,0.6)",
    "backdrop-filter:blur(2px)",
  ].join(";");

  const modal = document.createElement("div");
  modal.style.cssText = [
    "display:flex",
    "flex-direction:column",
    "width:min(420px,92vw)",
    "height:min(640px,86vh)",
    "overflow:hidden",
    "border-radius:16px",
    "background:var(--surface,#fff)",
    "color:var(--foreground,#111)",
    "border:1px solid var(--border,rgba(0,0,0,0.1))",
    "box-shadow:0 20px 60px rgba(0,0,0,0.35)",
  ].join(";");

  const header = document.createElement("div");
  header.style.cssText = [
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "padding:12px 16px",
    "border-bottom:1px solid var(--border,rgba(0,0,0,0.1))",
    "font-weight:700",
  ].join(";");
  const heading = document.createElement("span");
  heading.textContent = "Login with Circles";
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", "Close");
  close.textContent = "×";
  close.style.cssText = [
    "border:0",
    "background:transparent",
    "font-size:22px",
    "line-height:1",
    "cursor:pointer",
    "color:inherit",
  ].join(";");
  close.addEventListener("click", () => dismiss());
  header.append(heading, close);

  frame = document.createElement("iframe");
  frame.title = "Login with Circles";
  // WebAuthn passkeys are served from the connector origin; these grants let the
  // cross-origin iframe create and read credentials.
  frame.setAttribute(
    "allow",
    "publickey-credentials-get *; publickey-credentials-create *; clipboard-write",
  );
  frame.style.cssText = "flex:1;border:0;width:100%;background:transparent";
  frame.src = FRAME_SRC;

  modal.append(header, frame);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.body.appendChild(backdrop);

  window.addEventListener("message", onMessage);
}

function onMessage(event: MessageEvent): void {
  // Only trust messages from our own connector iframe.
  if (!frame || event.source !== frame.contentWindow) return;
  const d = event.data;
  if (!d || typeof d.type !== "string") return;

  switch (d.type) {
    case "crc_bridge_ready":
      bridgeReady = true;
      postRaw({ type: "request_address" });
      flushOutbox();
      break;
    case "wallet_connected":
      emit(d.address);
      settleConnect(d.address);
      hideModal();
      break;
    case "wallet_disconnected":
      emit(null);
      break;
    case "tx_success":
      pending[d.requestId]?.resolve(d.hashes ?? []);
      delete pending[d.requestId];
      hideModal();
      break;
    case "tx_rejected":
      pending[d.requestId]?.reject(
        new Error(d.error ?? d.reason ?? "Transaction rejected"),
      );
      delete pending[d.requestId];
      hideModal();
      break;
    case "sign_success":
      pending[d.requestId]?.resolve({
        signature: d.signature,
        verified: Boolean(d.verified),
      });
      delete pending[d.requestId];
      hideModal();
      break;
    case "sign_rejected":
      pending[d.requestId]?.reject(
        new Error(d.error ?? d.reason ?? "Signature rejected"),
      );
      delete pending[d.requestId];
      hideModal();
      break;
  }
}

function postRaw(data: unknown): void {
  frame?.contentWindow?.postMessage(data, CONNECTOR_ORIGIN);
}

/** Send now if the bridge is ready, otherwise buffer until it is. */
function post(data: unknown): void {
  if (!bridgeReady) {
    outbox.push(data);
    return;
  }
  postRaw(data);
}

function flushOutbox(): void {
  const queued = outbox;
  outbox = [];
  for (const data of queued) postRaw(data);
}

function showModal(): void {
  ensureFrame();
  if (backdrop) backdrop.style.display = "flex";
}

function hideModal(): void {
  if (backdrop) backdrop.style.display = "none";
  // A dismissal mid-connect resolves the pending connect() as "no address".
  settleConnect(address);
}

/**
 * User-initiated close (backdrop or × button). Fail any in-flight request so
 * awaiting callers (a game recording its result) don't hang on a never-settled
 * promise.
 */
function dismiss(): void {
  for (const id of Object.keys(pending)) {
    pending[id]!.reject(new Error("Closed before approval"));
    delete pending[id];
  }
  hideModal();
}

function settleConnect(value: string | null): void {
  if (!connectResolve) return;
  const resolve = connectResolve;
  connectResolve = null;
  resolve(value);
}

/**
 * Open the connector and resolve with the connected address (or null if the
 * user dismisses without connecting). Resolves immediately if already connected
 * this session.
 */
export function connect(): Promise<string | null> {
  ensureFrame();
  if (address) return Promise.resolve(address);
  return new Promise((resolve) => {
    connectResolve = resolve;
    showModal();
    if (bridgeReady) postRaw({ type: "request_address" });
  });
}

export function disconnect(): void {
  if (frame) post({ type: "disconnect" });
  emit(null);
}

/**
 * Route a transaction batch to the connector. Reveals the modal so the user can
 * approve with their passkey, then hides it once the connector responds.
 */
export function sendTransactions(
  transactions: Transaction[],
): Promise<string[]> {
  ensureFrame();
  return new Promise<string[]>((resolve, reject) => {
    const requestId = `crc_tx_${++requestCounter}`;
    pending[requestId] = {
      resolve: (v) => resolve(v as string[]),
      reject,
    };
    showModal();
    post({ type: "send_transactions", requestId, transactions });
  });
}

/** Request a message signature through the connector (same shapes as the SDK). */
export function signMessage(
  message: string,
  signatureType: "erc1271" | "raw" = "erc1271",
): Promise<SignResult> {
  ensureFrame();
  return new Promise<SignResult>((resolve, reject) => {
    const requestId = `crc_sign_${++requestCounter}`;
    pending[requestId] = {
      resolve: (v) => resolve(v as SignResult),
      reject,
    };
    showModal();
    post({ type: "sign_message", requestId, message, signatureType });
  });
}
