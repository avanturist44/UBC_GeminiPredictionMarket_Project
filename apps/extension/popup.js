// The toolbar popup: what the extension does, and a way to the site. Links open in a new
// tab and the popup closes, as a popup's links should.
(() => {
  const site = document.getElementById("site");
  site.href = TM.SITE_BASE + "/?src=ext";
  for (const link of document.querySelectorAll("a[href]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.tabs.create({ url: link.href });
      window.close();
    });
  }
})();
