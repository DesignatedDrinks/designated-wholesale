(function () {
  "use strict";

  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof HTMLFormElement === "undefined" ||
    typeof Node === "undefined"
  ) {
    return;
  }

  const LEGACY_ENDPOINT =
    "https://script.google.com/macros/s/AKfycbwhZRZht3Sw35KJqXpwwXR-uFvC15kyyNK0TUsE-y-FARXhlPSdl1UehiEdsHKvGHP57Q/exec";
  const PRODUCTION_ENDPOINT =
    "https://script.google.com/macros/s/AKfycbw-mYe47cHU4hNMIJ3wzLW2tMRDsRYlTQfWDkWSQ8dndqqVw6Phmdz--hGqWPTPSBs0uQ/exec";

  const nativeSubmit = HTMLFormElement.prototype.submit;
  const nativeAppendChild = Node.prototype.appendChild;

  function rewriteEndpoint(url) {
    const value = String(url || "");
    if (value.indexOf(LEGACY_ENDPOINT) === 0) {
      return PRODUCTION_ENDPOINT + value.slice(LEGACY_ENDPOINT.length);
    }
    return value;
  }

  // app.js uses JSONP for both catalogue reads and order-status polling.
  // Redirect those script requests to the current production Apps Script
  // deployment before the browser sends them.
  Node.prototype.appendChild = function (child) {
    if (
      child &&
      String(child.tagName || "").toUpperCase() === "SCRIPT" &&
      child.src
    ) {
      const rewritten = rewriteEndpoint(child.src);
      if (rewritten !== child.src) child.src = rewritten;
    }
    return nativeAppendChild.call(this, child);
  };

  function isWholesaleOrderForm(form) {
    const method = String(form.method || "").toLowerCase();
    const target = String(form.target || "");
    const action = String(form.action || "");

    return (
      method === "post" &&
      target === "order-submit-frame" &&
      (action.indexOf(LEGACY_ENDPOINT) === 0 || action.indexOf(PRODUCTION_ENDPOINT) === 0)
    );
  }

  function serializeForm(form) {
    const entries = [];
    const data = new FormData(form);

    data.forEach(function (value, key) {
      entries.push([key, String(value == null ? "" : value)]);
    });

    return entries;
  }

  function submitNativeFallback(action, entries) {
    const fallback = document.createElement("form");
    fallback.method = "POST";
    fallback.action = rewriteEndpoint(action);
    fallback.target = "order-submit-frame";
    fallback.hidden = true;

    entries.forEach(function (entry) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = entry[0];
      input.value = entry[1];
      fallback.appendChild(input);
    });

    document.body.appendChild(fallback);

    try {
      nativeSubmit.call(fallback);
    } finally {
      window.setTimeout(function () {
        fallback.remove();
      }, 1500);
    }
  }

  HTMLFormElement.prototype.submit = function () {
    if (!isWholesaleOrderForm(this)) {
      return nativeSubmit.call(this);
    }

    const action = rewriteEndpoint(this.action);
    const entries = serializeForm(this);
    const body = new URLSearchParams(entries);

    try {
      const request = window.fetch(action, {
        method: "POST",
        mode: "no-cors",
        body: body,
        keepalive: true,
        cache: "no-store",
        credentials: "omit"
      });

      Promise.resolve(request).catch(function (error) {
        console.warn("Wholesale fetch transport failed; using form fallback.", error);
        submitNativeFallback(action, entries);
      });
    } catch (error) {
      console.warn("Wholesale fetch transport could not start; using form fallback.", error);
      submitNativeFallback(action, entries);
    }
  };
})();
