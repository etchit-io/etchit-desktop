// Router that ships in every published site. Renders inside the page
// itself, no framework, no third-party code. Toggles each
// `<section data-page="…">` between hidden and visible to match the
// current route, and updates the `current` class on `<nav a[data-page]>`.
//
// Click handling is JS-direct (no URL change). The earlier version
// relied on `<a href="#…">` + `hashchange` for in-page navigation, but
// `about:srcdoc` iframes (used by the editor preview) treat the hash
// nav as a top-level redirect on some WebKit-derived embedders — the
// preview document disappears and the host reloads. Intercepting the
// click and toggling sections directly avoids touching the URL bar
// entirely.
//
// `hashchange` is still wired so external deep-links survive:
// `autonomi://<addr>#about` lands on the About section when the site
// is rendered inside fetch>it.

const ROUTER_SCRIPT = `<script>(function(){
  var sections=document.querySelectorAll('main section[data-page]');
  var navLinks=document.querySelectorAll('nav a[data-page]');
  function defaultId(){return (sections[0]&&sections[0].dataset.page)||'';}
  function show(id){
    if(!id){id=defaultId();}
    for(var i=0;i<sections.length;i++){sections[i].hidden=sections[i].dataset.page!==id;}
    for(var j=0;j<navLinks.length;j++){
      var a=navLinks[j];
      if(a.dataset.page===id){a.classList.add('current');}else{a.classList.remove('current');}
    }
    try{window.scrollTo({top:0});}catch(_){window.scrollTo(0,0);}
  }
  for(var k=0;k<navLinks.length;k++){
    (function(a){
      a.addEventListener('click',function(e){
        e.preventDefault();
        show(a.dataset.page);
      });
    })(navLinks[k]);
  }
  window.addEventListener('hashchange',function(){
    var id=(location.hash||'#').slice(1)||defaultId();
    show(id);
  });
  var initial=(location.hash||'#').slice(1)||defaultId();
  show(initial);
})();</script>`;

export function routerScript(): string {
  return ROUTER_SCRIPT;
}

/** Generate the navigation markup. `pages` is the ordered page list;
 *  the first page is the implicit default route. */
export function navHtml(pages: ReadonlyArray<{ id: string; name: string }>): string {
  if (pages.length <= 1) return "";
  const items = pages
    .map((p) => `<a data-page="${p.id}" href="#${p.id}">${escapeHtmlAttr(p.name)}</a>`)
    .join("");
  return `<nav>${items}</nav>`;
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
