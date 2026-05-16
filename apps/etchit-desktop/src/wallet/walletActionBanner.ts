// Fixed-top banner shown while an external-signer transaction is
// waiting for the user to act in their wallet. The "Sign payment in
// your wallet…" status was only landing on the etch button itself —
// easy to miss when the wallet popup didn't auto-fire on the phone
// (the common case with mobile wallets). This banner is full-width
// and high-contrast so the "go look at your wallet" cue can't be
// missed.
//
// Lifecycle is tied to a single transaction request — caller wraps
// `provider.request(...)` in try/finally and shows / hides here.

let bannerEl: HTMLDivElement | null = null;
let messageEl: HTMLSpanElement | null = null;
let cancelBtn: HTMLButtonElement | null = null;
let currentOnCancel: (() => void) | null = null;

function ensureBanner(): HTMLDivElement {
  if (bannerEl) return bannerEl;
  const el = document.createElement("div");
  el.className = "wallet-action-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "assertive");
  el.hidden = true;

  const msg = document.createElement("span");
  msg.className = "wallet-action-banner-msg";
  el.appendChild(msg);
  messageEl = msg;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wallet-action-banner-cancel";
  btn.textContent = "Cancel";
  btn.addEventListener("click", () => {
    if (currentOnCancel) currentOnCancel();
  });
  el.appendChild(btn);
  cancelBtn = btn;

  document.body.appendChild(el);
  bannerEl = el;
  return el;
}

/** Show the banner with a call-to-action. `onCancel` (when provided)
 *  is fired if the user clicks the Cancel button — caller is
 *  responsible for actually aborting the in-flight wallet request. */
export function showWalletActionBanner(
  message: string,
  onCancel?: () => void,
): void {
  const el = ensureBanner();
  if (messageEl) messageEl.textContent = message;
  currentOnCancel = onCancel ?? null;
  if (cancelBtn) cancelBtn.hidden = !onCancel;
  el.hidden = false;
}

/** Hide the banner. Safe to call when not shown. */
export function hideWalletActionBanner(): void {
  if (bannerEl) bannerEl.hidden = true;
  currentOnCancel = null;
}
