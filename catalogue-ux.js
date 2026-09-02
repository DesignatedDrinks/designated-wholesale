(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  const knownBreweries = new Set();
  let applying = false;
  let initialized = false;

  function moneyNumber(text) {
    const value = Number(String(text || "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(value) ? value : 0;
  }

  function cardData(card, index) {
    const brand = card.querySelector(".product-brand");
    const name = card.querySelector(".product-name");
    const category = card.querySelector(".category-pill");
    const meta = card.querySelector(".product-meta");
    const price = card.querySelector(".product-price strong");
    const metaText = String(meta && meta.textContent || "").trim();
    const style = metaText.split("·")[0].trim();

    if (!card.dataset.uxFeaturedIndex) card.dataset.uxFeaturedIndex = String(index);
    card.dataset.uxBrewery = String(brand && brand.textContent || "").trim();
    card.dataset.uxName = String(name && name.textContent || "").trim();
    card.dataset.uxCategory = String(category && category.textContent || "").trim();
    card.dataset.uxStyle = style;
    card.dataset.uxPrice = String(moneyNumber(price && price.textContent));

    if (card.dataset.uxBrewery) knownBreweries.add(card.dataset.uxBrewery);

    return {
      brewery: card.dataset.uxBrewery,
      name: card.dataset.uxName,
      category: card.dataset.uxCategory,
      style: card.dataset.uxStyle,
      price: Number(card.dataset.uxPrice || 0),
      featuredIndex: Number(card.dataset.uxFeaturedIndex || index)
    };
  }

  function addCardTags(card) {
    const body = card.querySelector(".product-body");
    if (!body || body.querySelector(".product-tags")) return;

    const category = card.dataset.uxCategory;
    const style = card.dataset.uxStyle;
    if (!category && !style) return;

    const tags = document.createElement("div");
    tags.className = "product-tags";

    if (category) {
      const categoryTag = document.createElement("span");
      categoryTag.className = "product-tag";
      categoryTag.textContent = category;
      tags.appendChild(categoryTag);
    }

    if (style && style.toLowerCase() !== String(category || "").toLowerCase()) {
      const styleTag = document.createElement("span");
      styleTag.className = "product-tag is-style";
      styleTag.textContent = style;
      tags.appendChild(styleTag);
    }

    body.insertBefore(tags, body.firstChild);
  }

  function controlValue(id, fallback) {
    const element = document.getElementById(id);
    return element ? element.value : fallback;
  }

  function populateBreweryOptions() {
    const select = document.getElementById("brewery-filter");
    if (!select) return;

    const current = select.value || "All";
    const breweries = Array.from(knownBreweries).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });

    const expected = ["All"].concat(breweries);
    const existing = Array.from(select.options).map(function (option) { return option.value; });
    if (expected.join("\u0000") === existing.join("\u0000")) return;

    select.replaceChildren();
    const all = document.createElement("option");
    all.value = "All";
    all.textContent = "All breweries";
    select.appendChild(all);

    breweries.forEach(function (brewery) {
      const option = document.createElement("option");
      option.value = brewery;
      option.textContent = brewery;
      select.appendChild(option);
    });

    select.value = expected.includes(current) ? current : "All";
  }

  function comparator(sort) {
    return function (a, b) {
      const ad = cardData(a, 0);
      const bd = cardData(b, 0);
      if (sort === "product-az") {
        return ad.name.localeCompare(bd.name, undefined, { sensitivity: "base" }) ||
          ad.brewery.localeCompare(bd.brewery, undefined, { sensitivity: "base" });
      }
      if (sort === "price-low") return ad.price - bd.price || ad.name.localeCompare(bd.name);
      if (sort === "price-high") return bd.price - ad.price || ad.name.localeCompare(bd.name);
      if (sort === "featured") return ad.featuredIndex - bd.featuredIndex;
      return ad.brewery.localeCompare(bd.brewery, undefined, { sensitivity: "base" }) ||
        ad.name.localeCompare(bd.name, undefined, { sensitivity: "base" });
    };
  }

  function updateResultsMeta(total, visible) {
    const meta = document.getElementById("catalogue-results-meta");
    if (!meta) return;
    const brewery = controlValue("brewery-filter", "All");
    const sort = controlValue("sort-products", "brewery-az");
    const sortLabels = {
      "brewery-az": "Brewery A–Z",
      "product-az": "Product A–Z",
      "price-low": "Price low to high",
      "price-high": "Price high to low",
      "featured": "Featured order"
    };

    const count = meta.querySelector("strong");
    const detail = meta.querySelector("span");
    if (count) count.textContent = "Showing " + visible + (visible === total ? " products" : " of " + total + " products");
    if (detail) detail.textContent = (brewery === "All" ? "All breweries" : brewery) + " · " + (sortLabels[sort] || "Brewery A–Z");
  }

  function updateEmptyState(total, visible) {
    const empty = document.getElementById("empty-state");
    if (!empty) return;

    if (total > 0 && visible === 0) {
      empty.hidden = false;
      empty.dataset.uxBreweryEmpty = "true";
      const heading = empty.querySelector("h2");
      const copy = empty.querySelector("p");
      if (heading) heading.textContent = "No products from this brewery";
      if (copy) copy.textContent = "Try another brewery, category or search.";
      return;
    }

    if (empty.dataset.uxBreweryEmpty === "true" && visible > 0) {
      empty.hidden = true;
      delete empty.dataset.uxBreweryEmpty;
      const heading = empty.querySelector("h2");
      const copy = empty.querySelector("p");
      if (heading) heading.textContent = "No products found";
      if (copy) copy.textContent = "Try another search or category.";
    }
  }

  function applyCatalogueUx() {
    if (applying) return;
    const grid = document.getElementById("product-grid");
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll(":scope > .product-card"));
    if (!cards.length) {
      updateResultsMeta(0, 0);
      return;
    }

    applying = true;
    try {
      cards.forEach(function (card, index) {
        cardData(card, index);
        addCardTags(card);
      });
      populateBreweryOptions();

      const brewery = controlValue("brewery-filter", "All");
      const sort = controlValue("sort-products", "brewery-az");
      let visible = 0;

      cards.forEach(function (card) {
        const matches = brewery === "All" || card.dataset.uxBrewery === brewery;
        card.hidden = !matches;
        if (matches) visible += 1;
      });

      const sorted = cards.slice().sort(comparator(sort));
      const currentOrder = cards.map(function (card) { return card.dataset.productSku || card.dataset.uxName; }).join("\u0000");
      const sortedOrder = sorted.map(function (card) { return card.dataset.productSku || card.dataset.uxName; }).join("\u0000");
      if (currentOrder !== sortedOrder) {
        sorted.forEach(function (card) { grid.appendChild(card); });
      }

      updateResultsMeta(cards.length, visible);
      updateEmptyState(cards.length, visible);
    } finally {
      applying = false;
    }
  }

  function makeSelectField(labelText, select) {
    const label = document.createElement("label");
    label.className = "catalogue-select-field";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = labelText;
    label.append(labelSpan, select);
    return label;
  }

  function installControls() {
    if (initialized) return;
    const toolbar = document.querySelector(".catalogue-toolbar");
    const shopLayout = document.querySelector(".shop-layout");
    if (!toolbar || !shopLayout) return;
    initialized = true;

    const search = document.getElementById("search-input");
    if (search) search.placeholder = "Search brewery or product…";

    const refine = document.createElement("div");
    refine.className = "catalogue-refine";

    const brewery = document.createElement("select");
    brewery.id = "brewery-filter";
    brewery.setAttribute("aria-label", "Filter by brewery");
    const all = document.createElement("option");
    all.value = "All";
    all.textContent = "All breweries";
    brewery.appendChild(all);

    const sort = document.createElement("select");
    sort.id = "sort-products";
    sort.setAttribute("aria-label", "Sort products");
    [
      ["brewery-az", "Brewery A–Z"],
      ["product-az", "Product A–Z"],
      ["price-low", "Price: low to high"],
      ["price-high", "Price: high to low"],
      ["featured", "Featured order"]
    ].forEach(function (pair) {
      const option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      sort.appendChild(option);
    });
    sort.value = "brewery-az";

    const clear = document.createElement("button");
    clear.id = "catalogue-clear-all";
    clear.type = "button";
    clear.className = "catalogue-clear-button";
    clear.textContent = "Reset filters";

    refine.append(
      makeSelectField("Brewery", brewery),
      makeSelectField("Sort by", sort),
      clear
    );
    toolbar.appendChild(refine);

    const resultsMeta = document.createElement("div");
    resultsMeta.id = "catalogue-results-meta";
    resultsMeta.className = "catalogue-results-meta";
    const count = document.createElement("strong");
    count.textContent = "Showing products";
    const detail = document.createElement("span");
    detail.textContent = "Brewery A–Z";
    resultsMeta.append(count, detail);
    shopLayout.parentNode.insertBefore(resultsMeta, shopLayout);

    brewery.addEventListener("change", applyCatalogueUx);
    sort.addEventListener("change", applyCatalogueUx);
    clear.addEventListener("click", function () {
      brewery.value = "All";
      sort.value = "brewery-az";

      const searchInput = document.getElementById("search-input");
      if (searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      const allCategory = document.querySelector('#category-filters [data-category="All"]');
      if (allCategory && allCategory.getAttribute("aria-pressed") !== "true") allCategory.click();
      window.setTimeout(applyCatalogueUx, 0);
    });

    const grid = document.getElementById("product-grid");
    if (grid) {
      const observer = new MutationObserver(function () {
        window.requestAnimationFrame(applyCatalogueUx);
      });
      observer.observe(grid, { childList: true });
    }

    window.requestAnimationFrame(applyCatalogueUx);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installControls);
  } else {
    installControls();
  }
})();
