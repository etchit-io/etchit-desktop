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

function ensureBanner(): HTMLDivElement {
  if (bannerEl) return bannerEl;
  const el = document.createElement("div");
  el.className = "wallet-action-banner";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "assertive");
  el.hidden = true;
  document.body.appendChild(el);
  bannerEl = el;
  return el;
}

/** Show the banner with a specific call-to-action. Idempotent —
 *  calling again just updates the text. */
export function showWalletActionBanner(message: string): void {
  const el = ensureBanner();
  el.textContent = message;
  el.hidden = false;
}

/** Hide the banner. Safe to call when not shown. */
export function hideWalletActionBanner(): void {
  if (bannerEl) bannerEl.hidden = true;
}
