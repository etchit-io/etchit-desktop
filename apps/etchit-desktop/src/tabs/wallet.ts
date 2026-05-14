export function mountWallet(host: HTMLElement): void {
  host.innerHTML = `
    <div class="tab-placeholder">
      <h1>Wallet</h1>
      <p class="tab-lede">
        WalletConnect status and approval budget. Etches pay a small amount
        of ANT on Arbitrum One; reads are always free. Your wallet signs
        every transaction &mdash; etch/it never touches your keys.
      </p>
      <span class="tab-tag">In development</span>
    </div>
  `;
}
