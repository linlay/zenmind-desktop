(function () {
  var script = document.currentScript;
  var TOKEN = script && script.dataset ? script.dataset.zenmindReviewToken || "" : "";
  if (!TOKEN) return;

  var ROOT_ID = "__zenmind_native_html_review_overlay__";
  var enabled = false;
  var hoverBox = null;
  var markerItems = [];
  var previousCursor = "";
  var renderFrame = 0;

  function root() {
    var existing = document.getElementById(ROOT_ID);
    if (existing) return existing;
    var value = document.createElement("div");
    value.id = ROOT_ID;
    Object.assign(value.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      overflow: "visible",
    });
    (document.body || document.documentElement).appendChild(value);
    return value;
  }

  function createBox(rect, label, dashed) {
    var box = document.createElement("div");
    box.dataset.zenmindReviewBox = "true";
    Object.assign(box.style, {
      position: "fixed",
      left: rect.left + "px",
      top: rect.top + "px",
      width: Math.max(0, rect.width) + "px",
      height: Math.max(0, rect.height) + "px",
      boxSizing: "border-box",
      border: "2px " + (dashed ? "dashed" : "solid") + " #ff4d4f",
      background: dashed ? "rgba(255,77,79,.08)" : "rgba(255,77,79,.05)",
      pointerEvents: "none",
    });
    if (label) {
      var badge = document.createElement("span");
      badge.textContent = String(label);
      Object.assign(badge.style, {
        position: "absolute",
        top: "-11px",
        left: "-11px",
        display: "grid",
        placeItems: "center",
        width: "22px",
        height: "22px",
        borderRadius: "999px",
        background: "#ff4d4f",
        color: "#fff",
        fontSize: "11px",
        fontWeight: "700",
        lineHeight: "1",
        boxShadow: "0 2px 8px rgba(0,0,0,.24)",
      });
      box.appendChild(badge);
    }
    return box;
  }

  function removeMarkerBoxes() {
    var value = document.getElementById(ROOT_ID);
    if (!value) return;
    Array.from(value.querySelectorAll("[data-zenmind-review-marker]")).forEach(function (node) {
      node.remove();
    });
  }

  function query(selector) {
    try {
      return selector ? document.querySelector(selector) : null;
    } catch (_error) {
      return null;
    }
  }

  function renderMarkers() {
    removeMarkerBoxes();
    if (!enabled) return;
    var value = root();
    markerItems.forEach(function (item, index) {
      var element = query(item.selector);
      if (!(element instanceof Element)) return;
      var rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      var box = createBox(rect, item.number || index + 1, false);
      box.dataset.zenmindReviewMarker = "true";
      value.appendChild(box);
    });
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(function () {
      renderFrame = 0;
      renderMarkers();
    });
  }

  function targetAtPoint(x, y) {
    var elements = document.elementsFromPoint(x, y);
    return elements.find(function (element) {
      return !element.closest("#" + ROOT_ID);
    }) || null;
  }

  function cssPath(element) {
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1) {
      if (current.id && window.CSS && typeof window.CSS.escape === "function") {
        parts.unshift("#" + window.CSS.escape(current.id));
        break;
      }
      var part = current.tagName.toLowerCase();
      var owner = current.parentElement;
      if (owner) {
        var same = Array.from(owner.children).filter(function (candidate) {
          return candidate.tagName === current.tagName;
        });
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
      }
      parts.unshift(part);
      current = owner;
    }
    return parts.join(" > ");
  }

  function fullXPath(element) {
    var parts = [];
    var current = element;
    while (current && current.nodeType === 1) {
      var name = current.tagName.toLowerCase();
      if (name === "html") {
        parts.unshift("html");
        break;
      }
      var owner = current.parentElement;
      if (!owner) return "";
      var same = Array.from(owner.children).filter(function (candidate) {
        return candidate.tagName === current.tagName;
      });
      parts.unshift(name + "[" + (same.indexOf(current) + 1) + "]");
      current = owner;
    }
    return "/" + parts.join("/");
  }

  function textExcerpt(element) {
    return (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
  }

  function setEnabled(next) {
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      previousCursor = document.documentElement.style.cursor;
      document.documentElement.style.cursor = "crosshair";
      renderMarkers();
    } else {
      document.documentElement.style.cursor = previousCursor;
      if (hoverBox) hoverBox.remove();
      hoverBox = null;
      removeMarkerBoxes();
    }
  }

  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.token !== TOKEN) return;
    if (data.type === "zenmind-html-annotation-mode") {
      setEnabled(Boolean(data.enabled));
      return;
    }
    if (data.type !== "zenmind-html-annotation-locate" || !Array.isArray(data.items)) return;
    markerItems = data.items.slice(0, 64).map(function (item, index) {
      return {
        id: typeof item.id === "string" ? item.id.slice(0, 128) : "",
        selector: typeof item.selector === "string" ? item.selector.slice(0, 512) : "",
        number: Number.isSafeInteger(item.number) && item.number > 0 ? item.number : index + 1,
      };
    });
    renderMarkers();
    var results = markerItems.map(function (item) {
      var element = query(item.selector);
      if (!(element instanceof Element)) return { id: item.id, valid: false };
      var rect = element.getBoundingClientRect();
      return {
        id: item.id,
        valid: rect.width > 0 && rect.height > 0,
        text: textExcerpt(element),
        rect: {
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
        },
      };
    });
    parent.postMessage({ type: "zenmind-html-annotation-located", token: TOKEN, items: results }, "*");
  });

  document.addEventListener("pointermove", function (event) {
    if (!enabled) return;
    var element = targetAtPoint(event.clientX, event.clientY);
    if (hoverBox) hoverBox.remove();
    hoverBox = null;
    if (!(element instanceof Element)) return;
    var rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    hoverBox = createBox(rect, 0, true);
    root().appendChild(hoverBox);
  }, true);

  document.addEventListener("pointerdown", function (event) {
    if (!enabled || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("pointerup", function (event) {
    if (!enabled || event.button !== 0) return;
    var element = targetAtPoint(event.clientX, event.clientY);
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!(element instanceof Element)) return;
    var selector = cssPath(element);
    var xpath = fullXPath(element);
    var rect = element.getBoundingClientRect();
    if (!selector || !xpath || rect.width <= 0 || rect.height <= 0) return;
    parent.postMessage({
      type: "zenmind-html-annotation",
      token: TOKEN,
      selector: selector,
      xpath: xpath,
      text: textExcerpt(element),
      rect: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
      },
    }, "*");
  }, true);

  document.addEventListener("click", function (event) {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  document.addEventListener("submit", function (event) {
    if (!enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  window.addEventListener("resize", scheduleRender);
  window.addEventListener("scroll", scheduleRender, true);
})();
