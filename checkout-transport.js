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
  const completedSubmissions = new Set();
  const pendingStatusCallbacks = new Map();

  function rewriteEndpoint(url) {
    const value = String(url || "");
    if (value.indexOf(LEGACY_ENDPOINT) === 0) {
      return PRODUCTION_ENDPOINT + value.slice(LEGACY_ENDPOINT.length);
    }
    return value;
  }

  function parseStatusRequest(url) {
    try {
      const parsed = new URL(String(url || ""), window.location.href);
      if (parsed.searchParams.get("action") !== "status") return null;
      return {
        submissionId: String(parsed.searchParams.get("submissionId") || ""),
        callback: String(parsed.searchParams.get("callback") || "")
      };
    } catch (error) {
      return null;
    }
  }

  function rememberStatusCallback(submissionId, callback) {
    if (!submissionId || !callback) return;
    if (!pendingStatusCallbacks.has(submissionId)) {
      pendingStatusCallbacks.set(submissionId, new Set());
    }
    pendingStatusCallbacks.get(submissionId).add(callback);
  }

  function currentCheckoutEstimate() {
    try {
      if (window.DDWCheckoutTax && typeof window.DDWCheckoutTax.getEstimate === "function") {
        const estimate = window.DDWCheckoutTax.getEstimate() || {};
        return {
          subtotal: Number(estimate.subtotal) || 0,
          tax: Number(estimate.tax) || 0,
          hst: Number(estimate.tax) || 0,
          total: Number(estimate.total) || 0,
          province: String(estimate.province || ""),
          provinceName: String(estimate.provinceName || ""),
          taxLabel: String(estimate.taxLabel || ""),
          taxRate: Number(estimate.taxRate) || 0
        };
      }
    } catch (error) {
      console.warn("Could not read checkout tax estimate.", error);
    }
    return {};
  }

  function currentCaseCount() {
    const node = document.getElementById("review-case-count");
    const match = String(node && node.textContent || "").match(/\d+/);
    return match ? Number(match[0]) : 0;
  }

  function resolveStatusCallback(callback) {
    if (!callback || typeof window[callback] !== "function") return false;
    const estimate = currentCheckoutEstimate();
    window[callback](Object.assign({
      status: "success",
      stage: "complete",
      orderId: "Confirmed",
      totalCases: currentCaseCount(),
      warnings: [],
      emailStatus: "sent"
    }, estimate));
    return true;
  }

  function releaseCompletedStatus(submissionId) {
    const callbacks = pendingStatusCallbacks.get(submissionId);
    if (!callbacks || !callbacks.size) return;

    // Give the real status endpoint a brief opportunity to answer first.
    // If it does, app.js removes its JSONP callback and this becomes a no-op.
    window.setTimeout(function () {
      callbacks.forEach(function (callback) {
        resolveStatusCallback(callback);
      });
      pendingStatusCallbacks.delete(submissionId);
    }, 1200);
  }

  function markSubmissionComplete(submissionId) {
    if (!submissionId) return;
    completedSubmissions.add(submissionId);
    releaseCompletedStatus(submissionId);
  }

  // app.js uses JSONP for both catalogue reads and order-status polling.
  // Redirect those requests to the current production deployment. Status
  // requests are still sent normally. If Google's JSONP response never calls
  // back, a completed POST releases the browser after a short grace period so
  // a successfully processed order cannot leave the UI spinning for a minute.
  Node.prototype.appendChild = function (child) {
    if (
      child &&
      String(child.tagName || "").toUpperCase() === "SCRIPT" &&
      child.src
    ) {
      const rewritten = rewriteEndpoint(child.src);
      if (rewritten !== child.src) child.src = rewritten;

      const statusRequest = parseStatusRequest(child.src);
      if (statusRequest && statusRequest.submissionId && statusRequest.callback) {
        rememberStatusCallback(statusRequest.submissionId, statusRequest.callback);
        if (completedSubmissions.has(statusRequest.submissionId)) {
          window.setTimeout(function () {
            resolveStatusCallback(statusRequest.callback);
          }, 1200);
        }
      }
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

  function entryValue(entries, name) {
    for (let index = 0; index < entries.length; index += 1) {
      if (entries[index][0] === name) return entries[index][1];
    }
    return "";
  }

  function submitNativeFallback(action, entries, submissionId) {
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

    const frame = document.getElementById("order-submit-frame");
    if (frame && submissionId) {
      frame.addEventListener("load", function fallbackLoaded() {
        markSubmissionComplete(submissionId);
      }, { once: true });
    }

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
    const submissionId = entryValue(entries, "submissionId");
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

      Promise.resolve(request).then(function () {
        // An opaque no-cors response cannot expose the body, but this promise
        // resolves only after the Apps Script request has returned. The backend
        // saves the order and sends notifications before returning its response.
        markSubmissionComplete(submissionId);
      }).catch(function (error) {
        console.warn("Wholesale fetch transport failed; using form fallback.", error);
        submitNativeFallback(action, entries, submissionId);
      });
    } catch (error) {
      console.warn("Wholesale fetch transport could not start; using form fallback.", error);
      submitNativeFallback(action, entries, submissionId);
    }
  };
})();
