export function mountHistory(host: HTMLElement): void {
  host.innerHTML = `
    <div class="tab-placeholder">
      <h1>History</h1>
      <p class="tab-lede">
        Every address you&rsquo;ve etched, with timestamp, label, and the
        amount of ANT spent. Click an entry to open it in
        <strong>fetch&gt;it</strong>.
      </p>
      <span class="tab-tag">In development</span>
    </div>
  `;
}
