// Sandboxed page hosting the official draw.io viewer. The parent posts {type:"render", xml};
// this replies {type:"rendered"} or {type:"error", message}. Re-rendering keeps the page shown.
(function () {
  var host = document.getElementById("g");
  var viewer;
  function reply(message) { parent.postMessage(message, "*"); }
  function currentPage() {
    var page = viewer && viewer.currentPage;
    return typeof page === "number" ? page : 0;
  }
  function render(xml) {
    var doc = new DOMParser().parseFromString(xml, "text/xml");
    if (doc.getElementsByTagName("parsererror").length || !doc.documentElement) throw new Error("不是有效的 draw.io XML");
    var page = currentPage();
    host.replaceChildren();
    viewer = new GraphViewer(host, doc.documentElement, {
      toolbar: "pages zoom layers", nav: true, lightbox: false, resize: true, center: true, page: page, "toolbar-position": "bottom",
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent || !event.data || event.data.type !== "render") return;
    try { render(String(event.data.xml)); reply({ type: "rendered" }); }
    catch (error) { reply({ type: "error", message: String((error && error.message) || error) }); }
  });
  reply({ type: "ready" });
})();
