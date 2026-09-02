(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const ADDRESS_KEY = "ddw-wholesale-address-v3";
  const TAX_RULES = Object.freeze({
    AB: { name: "Alberta", label: "GST", rate: 0.05 },
    BC: { name: "British Columbia", label: "GST", rate: 0.05 },
    MB: { name: "Manitoba", label: "GST", rate: 0.05 },
    NB: { name: "New Brunswick", label: "HST", rate: 0.15 },
    NL: { name: "Newfoundland and Labrador", label: "HST", rate: 0.15 },
    NS: { name: "Nova Scotia", label: "HST", rate: 0.14 },
    NT: { name: "Northwest Territories", label: "GST", rate: 0.05 },
    NU: { name: "Nunavut", label: "GST", rate: 0.05 },
    ON: { name: "Ontario", label: "HST", rate: 0.13 },
    PE: { name: "Prince Edward Island", label: "HST", rate: 0.15 },
    QC: { name: "Quebec", label: "GST", rate: 0.05 },
    SK: { name: "Saskatchewan", label: "GST", rate: 0.05 },
    YT: { name: "Yukon", label: "GST", rate: 0.05 }
  });

  const PROVINCES = Object.keys(TAX_RULES).map(function (code) {
    return [code, TAX_RULES[code].name];
  }).sort(function (a, b) { return a[1].localeCompare(b[1]); });

  function money(text) {
    const number = Number(String(text || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(number) ? number : 0;
  }

  function formatMoney(value) {
    return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Math.round((Number(value) + Number.EPSILON) * 100) / 100);
  }

  function provinceOptions() {
    return ['<option value="">Select province</option>'].concat(PROVINCES.map(function (entry) {
      return '<option value="' + entry[0] + '">' + entry[1] + '</option>';
    })).join("");
  }

  function injectStyles() {
    if (document.getElementById("checkout-flow-styles")) return;
    const style = document.createElement("style");
    style.id = "checkout-flow-styles";
    style.textContent = [
      ".checkout-form{display:grid;gap:18px}",
      ".checkout-fast-intro{display:flex;justify-content:space-between;gap:12px;align-items:start}",
      ".checkout-fast-intro h3{margin:0;font-size:1.2rem}",
      ".checkout-fast-intro p{margin:4px 0 0;color:var(--muted);font-size:.82rem}",
      ".checkout-required-note{flex:0 0 auto;color:var(--muted);font-size:.72rem;font-weight:700}",
      ".checkout-contact-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
      ".checkout-contact-grid .company-field{grid-column:1/-1}",
      ".checkout-form .field{display:grid;gap:6px;min-width:0}",
      ".checkout-form .field>span{font-size:.78rem;font-weight:800;color:var(--navy-900)}",
      ".checkout-form .field em{font-style:normal;color:var(--muted);font-weight:500}",
      ".checkout-form input,.checkout-form textarea,.checkout-form select{width:100%;min-height:48px;padding:11px 12px;border:1px solid var(--line-strong);border-radius:11px;background:#fff;color:var(--ink);outline:0}",
      ".checkout-form textarea{min-height:86px;resize:vertical}",
      ".checkout-form input:focus,.checkout-form textarea:focus,.checkout-form select:focus{border-color:var(--blue-500);box-shadow:0 0 0 3px rgba(22,132,217,.12)}",
      ".checkout-form .field.has-error input,.checkout-form .field.has-error textarea,.checkout-form .field.has-error select{border-color:var(--danger)}",
      ".fulfilment-choice{margin:0;padding:0;border:0;display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".fulfilment-choice legend{grid-column:1/-1;margin:0 0 2px;font-size:.78rem;font-weight:800;color:var(--navy-900)}",
      ".fulfilment-choice label{position:relative;display:block;cursor:pointer}",
      ".fulfilment-choice input{position:absolute;opacity:0;pointer-events:none}",
      ".fulfilment-choice label>span{min-height:72px;padding:13px 14px;display:grid;align-content:center;border:1px solid var(--line-strong);border-radius:12px;background:#fff;transition:.15s ease}",
      ".fulfilment-choice strong{font-size:.92rem}",
      ".fulfilment-choice small{margin-top:2px;color:var(--muted);font-size:.74rem}",
      ".fulfilment-choice input:checked+span{border-color:var(--blue-500);box-shadow:0 0 0 2px rgba(22,132,217,.11);background:#f7fbff}",
      ".delivery-card{padding:15px;border:1px solid var(--line);border-radius:14px;background:#f8fafc}",
      ".delivery-card-header{display:flex;justify-content:space-between;gap:12px;align-items:start;margin-bottom:12px}",
      ".delivery-card-header strong{font-size:.92rem}",
      ".delivery-card-header span{display:block;margin-top:2px;color:var(--muted);font-size:.74rem}",
      ".address-grid{display:grid;grid-template-columns:1.25fr .75fr;gap:10px}",
      ".address-grid .street-field{grid-column:1/-1}",
      ".tax-preview{padding:10px 11px;display:flex;justify-content:space-between;gap:10px;align-items:center;border-radius:10px;background:#eef5fb;color:#36536f;font-size:.75rem}",
      ".tax-preview strong{color:var(--navy-900)}",
      ".optional-order-details{border:1px solid var(--line);border-radius:12px;background:#fff}",
      ".optional-order-details summary{padding:12px 14px;cursor:pointer;color:var(--navy-900);font-size:.8rem;font-weight:800;list-style:none}",
      ".optional-order-details summary::-webkit-details-marker{display:none}",
      ".optional-order-details summary:after{content:'+';float:right;font-size:1rem}",
      ".optional-order-details[open] summary:after{content:'−'}",
      ".optional-order-fields{padding:0 14px 14px;display:grid;grid-template-columns:.8fr 1.2fr;gap:10px}",
      ".review-totals #tax-destination{display:block;margin-top:2px;color:var(--muted);font-size:.67rem;font-weight:500}",
      ".checkout-form .place-order{margin-top:0;min-height:52px}",
      "#delivery-address[hidden]{display:none!important}",
      "@media(max-width:760px){.checkout-contact-grid,.address-grid,.optional-order-fields,.fulfilment-choice{grid-template-columns:1fr}.checkout-contact-grid .company-field,.address-grid .street-field,.fulfilment-choice legend{grid-column:auto}.delivery-card{padding:12px}.checkout-fast-intro{display:block}.checkout-required-note{display:none}}"
    ].join("\n");
    document.head.appendChild(style);
  }

  function installMarkup() {
    const form = document.getElementById("checkout-form");
    if (!form || form.dataset.fastCheckoutInstalled === "true") return;
    form.dataset.fastCheckoutInstalled = "true";
    injectStyles();

    form.innerHTML = [
      '<div class="checkout-fast-intro"><div><h3>Checkout details</h3><p>Fast checkout. We’ll confirm freight before invoicing.</p></div><span class="checkout-required-note">Required unless marked optional</span></div>',
      '<div class="checkout-contact-grid">',
        '<label class="field company-field"><span>Company</span><input id="company-name" name="companyName" type="text" autocomplete="organization" maxlength="160" required><small class="field-error"></small></label>',
        '<label class="field"><span>Contact</span><input id="contact-name" name="fullName" type="text" autocomplete="name" maxlength="120" required><small class="field-error"></small></label>',
        '<label class="field"><span>Email</span><input id="email" name="email" type="email" autocomplete="email" maxlength="200" required><small class="field-error"></small></label>',
        '<label class="field"><span>Phone</span><input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="40" required><small class="field-error"></small></label>',
      '</div>',
      '<fieldset class="fulfilment-choice"><legend>Receive order</legend>',
        '<label><input type="radio" name="fulfilment" value="Delivery" checked><span><strong>Delivery</strong><small>Ship to your business.</small></span></label>',
        '<label><input type="radio" name="fulfilment" value="Pickup"><span><strong>Pickup</strong><small>Pick up in Ontario.</small></span></label>',
      '</fieldset>',
      '<section id="address-field" class="delivery-card">',
        '<div class="delivery-card-header"><div><strong>Delivery address</strong><span>Province sets the GST/HST estimate.</span></div></div>',
        '<div class="address-grid">',
          '<label class="field street-field"><span>Street address</span><input id="address-line1" type="text" autocomplete="address-line1" maxlength="160" required><small class="field-error"></small></label>',
          '<label class="field"><span>Unit <em>Optional</em></span><input id="address-line2" type="text" autocomplete="address-line2" maxlength="80"><small class="field-error"></small></label>',
          '<label class="field"><span>City</span><input id="address-city" type="text" autocomplete="address-level2" maxlength="100" required><small class="field-error"></small></label>',
          '<label class="field"><span>Province</span><select id="address-province" autocomplete="address-level1" required>' + provinceOptions() + '</select><small class="field-error"></small></label>',
          '<label class="field"><span>Postal code</span><input id="address-postal" type="text" inputmode="text" autocomplete="postal-code" maxlength="7" placeholder="A1A 1A1" required><small class="field-error"></small></label>',
        '</div>',
        '<div class="tax-preview"><span id="checkout-tax-context">Select a province to calculate tax</span><strong id="checkout-tax-rate">—</strong></div>',
        '<textarea id="delivery-address" name="deliveryAddress" maxlength="300" hidden></textarea>',
      '</section>',
      '<details class="optional-order-details"><summary>Add PO number or order notes</summary><div class="optional-order-fields">',
        '<label class="field"><span>PO number <em>Optional</em></span><input name="poNumber" type="text" maxlength="80"></label>',
        '<label class="field"><span>Order notes <em>Optional</em></span><input name="notes" type="text" maxlength="500"></label>',
      '</div></details>',
      '<label class="honeypot" aria-hidden="true">Website<input name="website" type="text" tabindex="-1" autocomplete="off"></label>',
      '<div id="form-alert" class="form-alert" role="alert" hidden></div>',
      '<button id="place-order" class="primary-button place-order" type="submit"><span>Place wholesale order</span><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m13 5-1.4 1.4 4.6 4.6H4v2h12.2l-4.6 4.6L13 19l7-7-7-7Z"/></svg></button>',
      '<p class="form-footnote">Order request only. Final freight is confirmed before invoicing.</p>'
    ].join("");

    const taxAmount = document.getElementById("review-tax");
    if (taxAmount) {
      const row = taxAmount.closest("div");
      const label = row && row.querySelector("dt");
      if (label) {
        label.id = "review-tax-label";
        label.innerHTML = 'HST (13%)<small id="tax-destination">Ontario pickup</small>';
      }
    }
  }

  function currentFulfilment() {
    const checked = document.querySelector('#checkout-form [name="fulfilment"]:checked');
    return checked ? checked.value : "Delivery";
  }

  function currentProvince() {
    if (currentFulfilment() === "Pickup") return "ON";
    const select = document.getElementById("address-province");
    return select ? select.value : "";
  }

  function normalizePostal(value) {
    const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    return compact.length > 3 ? compact.slice(0, 3) + " " + compact.slice(3) : compact;
  }

  function buildDeliveryAddress() {
    if (currentFulfilment() !== "Delivery") return "";
    const street = String((document.getElementById("address-line1") || {}).value || "").trim();
    const unit = String((document.getElementById("address-line2") || {}).value || "").trim();
    const city = String((document.getElementById("address-city") || {}).value || "").trim();
    const province = currentProvince();
    const postal = normalizePostal(String((document.getElementById("address-postal") || {}).value || ""));
    const lines = [street];
    if (unit) lines.push(unit);
    if (city || province || postal) lines.push(city + (city && province ? ", " : "") + province + (postal ? " " + postal : ""));
    return lines.filter(Boolean).join("\n");
  }

  function syncLegacyAddress() {
    const target = document.getElementById("delivery-address");
    if (target) target.value = buildDeliveryAddress();
  }

  function saveAddressDraft() {
    try {
      const fields = ["address-line1", "address-line2", "address-city", "address-province", "address-postal"];
      const data = {};
      fields.forEach(function (id) {
        const element = document.getElementById(id);
        data[id] = element ? element.value : "";
      });
      localStorage.setItem(ADDRESS_KEY, JSON.stringify(data));
    } catch (error) {}
  }

  function restoreAddressDraft() {
    try {
      const data = JSON.parse(localStorage.getItem(ADDRESS_KEY) || "null");
      if (!data) return;
      Object.keys(data).forEach(function (id) {
        const element = document.getElementById(id);
        if (element && !element.value) element.value = data[id] || "";
      });
    } catch (error) {}
  }

  function setFieldValidity(element, message) {
    if (!element) return false;
    element.setCustomValidity(message || "");
    const field = element.closest(".field");
    if (field) field.classList.toggle("has-error", Boolean(message));
    const error = field && field.querySelector(".field-error");
    if (error) error.textContent = message || "";
    return !message;
  }

  function validateAddress() {
    if (currentFulfilment() !== "Delivery") {
      syncLegacyAddress();
      return true;
    }
    const street = document.getElementById("address-line1");
    const city = document.getElementById("address-city");
    const province = document.getElementById("address-province");
    const postal = document.getElementById("address-postal");
    const postalValue = normalizePostal(postal && postal.value);
    if (postal) postal.value = postalValue;

    const valid = [
      setFieldValidity(street, street && street.value.trim() ? "" : "Enter the street address."),
      setFieldValidity(city, city && city.value.trim() ? "" : "Enter the city."),
      setFieldValidity(province, province && TAX_RULES[province.value] ? "" : "Select the province."),
      setFieldValidity(postal, /^[A-Z]\d[A-Z] \d[A-Z]\d$/.test(postalValue) ? "" : "Enter a Canadian postal code.")
    ].every(Boolean);

    syncLegacyAddress();
    if (!valid) {
      const first = document.querySelector("#address-field .field.has-error input, #address-field .field.has-error select");
      if (first) first.focus();
    }
    return valid;
  }

  function refreshTax() {
    const province = currentProvince();
    const rule = TAX_RULES[province] || null;
    const context = document.getElementById("checkout-tax-context");
    const rate = document.getElementById("checkout-tax-rate");
    const label = document.getElementById("review-tax-label");
    const destination = document.getElementById("tax-destination");
    const subtotalNode = document.getElementById("review-subtotal");
    const taxNode = document.getElementById("review-tax");
    const totalNode = document.getElementById("review-total");

    if (context) context.textContent = rule ? rule.label + " based on " + rule.name : "Select a province to calculate tax";
    if (rate) rate.textContent = rule ? Math.round(rule.rate * 1000) / 10 + "%" : "—";
    if (!rule) return;

    if (label) label.childNodes[0].nodeValue = rule.label + " (" + (Math.round(rule.rate * 1000) / 10) + "%)";
    if (destination) destination.textContent = currentFulfilment() === "Pickup" ? "Ontario pickup" : rule.name + " delivery";

    const subtotal = money(subtotalNode && subtotalNode.textContent);
    const tax = Math.round((subtotal * rule.rate + Number.EPSILON) * 100) / 100;
    if (taxNode) taxNode.textContent = formatMoney(tax);
    if (totalNode) totalNode.textContent = formatMoney(subtotal + tax);
  }

  function bind() {
    const form = document.getElementById("checkout-form");
    if (!form) return;
    restoreAddressDraft();
    syncLegacyAddress();
    refreshTax();

    form.addEventListener("submit", function (event) {
      syncLegacyAddress();
      if (!validateAddress()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const alert = document.getElementById("form-alert");
        if (alert) {
          alert.textContent = "Complete the delivery address to continue.";
          alert.hidden = false;
        }
      }
    }, true);

    form.addEventListener("change", function (event) {
      if (event.target.id === "address-province" || event.target.name === "fulfilment") {
        syncLegacyAddress();
        refreshTax();
      }
      if (event.target.matches("#address-field input, #address-field select")) {
        event.target.setCustomValidity("");
        const field = event.target.closest(".field");
        if (field) field.classList.remove("has-error");
        saveAddressDraft();
        syncLegacyAddress();
      }
    });

    form.addEventListener("input", function (event) {
      if (event.target.id === "address-postal") event.target.value = normalizePostal(event.target.value);
      if (event.target.matches("#address-field input")) {
        saveAddressDraft();
        syncLegacyAddress();
      }
    });

    const dialog = document.getElementById("checkout-dialog");
    if (dialog) {
      const observer = new MutationObserver(function () { window.requestAnimationFrame(refreshTax); });
      ["review-subtotal", "review-tax", "review-total"].forEach(function (id) {
        const node = document.getElementById(id);
        if (node) observer.observe(node, { childList: true, characterData: true, subtree: true });
      });
    }

    ["review-order", "mobile-order-bar"].forEach(function (id) {
      const button = document.getElementById(id);
      if (button) button.addEventListener("click", function () { window.setTimeout(refreshTax, 0); });
    });
  }

  installMarkup();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
