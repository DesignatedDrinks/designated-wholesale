(function () {
  "use strict";

  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof HTMLFormElement === "undefined"
  ) {
    return;
  }

  const nativeSubmit = HTMLFormElement.prototype.submit;
  const APPS_SCRIPT_PREFIX = "https://script.google.com/macros/s/";

  function isWholesaleOrderForm(form) {
    const method = String(form.method || "").toLowerCase();
    const target = String(form.target || "");
    const action = String(form.action || "");

    return (
      method === "post" &&
      target === "order-submit-frame" &&
      action.indexOf(APPS_SCRIPT_PREFIX) === 0
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
    fallback.action = action;
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

    const action = this.action;
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
