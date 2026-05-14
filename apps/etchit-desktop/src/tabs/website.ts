export function mountWebsite(host: HTMLElement): void {
  host.innerHTML = `
    <div class="tab-placeholder">
      <h1>Website</h1>
      <p class="tab-lede">
        Multi-file site builder. Drop a folder of HTML / CSS / assets, get
        back a single entry-point address that <strong>fetch&gt;it</strong>
        can open as a full SPA on Autonomi.
      </p>
      <span class="tab-tag">Desktop only &middot; in development</span>
    </div>
  `;
}
