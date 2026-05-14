export function mountBlogger(host: HTMLElement): void {
  host.innerHTML = `
    <div class="tab-placeholder">
      <h1>Blogger</h1>
      <p class="tab-lede">
        Longer-form composer for posts &mdash; title, body, tags &mdash; written
        out as an etch/it envelope so <strong>fetch&gt;it</strong> renders
        them with the right header.
      </p>
      <span class="tab-tag">In development</span>
    </div>
  `;
}
