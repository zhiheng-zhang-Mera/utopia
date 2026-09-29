/**
 * UTOPIA · Rooms — shared client kit for room UI modules.
 *
 * This file is loaded by the hub shell as a classic script (not an ES module) and
 * publishes everything on `globalThis.RoomsKit`, so each room's client.mjs can use
 * it without duplicating fetch, DOM and clipboard plumbing.
 */
(function publishRoomsKit(global) {
  'use strict';

  var API_BASE = '/local-rooms/v1';
  var ASSET_BASE = '/rooms';

  /** Create a DOM element with attributes and children. */
  function el(tag, attributes, children) {
    var node = document.createElement(tag);
    Object.keys(attributes || {}).forEach(function (key) {
      var value = attributes[key];
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style') node.setAttribute('style', value);
      else if (key.slice(0, 2) === 'on' && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });
    [].concat(children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  /** Escape text for safe innerHTML use. */
  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  /** Format an ISO timestamp for display. */
  function formatWhen(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
  }

  /** Short single-line preview of a longer text. */
  function preview(text, limit) {
    var flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!flat) return '—';
    var max = limit || 120;
    return flat.length > max ? flat.slice(0, max) + '…' : flat;
  }

  /** Split a comma separated tag input into a normalized list. */
  function parseTagsInput(value) {
    var seen = new Set();
    var out = [];
    String(value === undefined || value === null ? '' : value).split(',').forEach(function (raw) {
      var tag = raw.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      out.push(tag);
    });
    return out;
  }

  /** Download text content as a local file. */
  function downloadText(filename, text, contentType) {
    var blob = new Blob([text], { type: (contentType || 'application/json') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var anchor = el('a', { href: url, download: filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  /** SHA-256 of a string or ArrayBuffer using Web Crypto. */
  async function sha256Hex(input) {
    var bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
    if (!global.crypto || !global.crypto.subtle) return null;
    var digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  /** Copy text to the clipboard; resolves false when the browser refuses. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(String(text === undefined || text === null ? '' : text));
      return true;
    } catch {
      return false;
    }
  }

  /** Copy with a legacy fallback for headless or restricted contexts. */
  async function copyTextFallback(text) {
    if (await copyText(text)) return true;
    var area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = String(text === undefined || text === null ? '' : text);
    document.body.append(area);
    area.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /** Uniform status line helper used by every room. */
  function createFeedback(node) {
    return {
      set: function (text, kind) {
        node.textContent = text;
        if (kind) node.dataset.kind = kind;
        else delete node.dataset.kind;
      },
      error: function (error) {
        node.textContent = String((error && error.message) || error);
        node.dataset.kind = 'error';
      },
      clear: function () {
        node.textContent = '';
        delete node.dataset.kind;
      },
    };
  }

  /** Thin API client for one room. */
  function createRoomApi(roomId) {
    var base = API_BASE + '/' + roomId;

    async function request(path, options) {
      var settings = options || {};
      var response = await fetch(base + path, {
        method: settings.method,
        headers: settings.body ? { 'content-type': 'application/json' } : undefined,
        body: settings.body,
      });
      var text = await response.text();
      var payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }
      if (!response.ok) {
        var error = new Error((payload && payload.message) || 'request failed with ' + response.status);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    return {
      roomId: roomId,
      base: base,
      get: function (path) {
        return request(path || '');
      },
      post: function (path, body) {
        return request(path || '', { method: 'POST', body: JSON.stringify(body || {}) });
      },
      patch: function (path, body) {
        return request(path || '', { method: 'PATCH', body: JSON.stringify(body || {}) });
      },
      del: function (path) {
        return request(path || '', { method: 'DELETE' });
      },
      text: async function (path) {
        var response = await fetch(base + (path || ''));
        if (!response.ok) throw new Error('request failed with ' + response.status);
        return response.text();
      },
    };
  }

  /** Shared helper to build a two-pane room layout. */
  function twoPane(options) {
    var settings = options || {};
    var list = el('div', { class: 'pane' });
    var editor = el('div', { class: 'pane' });
    if (settings.leftTitle) list.append(el('h2', { class: 'pane-title', text: settings.leftTitle }));
    if (settings.rightTitle) editor.append(el('h2', { class: 'pane-title', text: settings.rightTitle }));
    return { grid: el('div', { class: 'room-grid' }, [list, editor]), list: list, editor: editor };
  }

  global.RoomsKit = {
    API_BASE: API_BASE,
    ASSET_BASE: ASSET_BASE,
    el: el,
    escapeHtml: escapeHtml,
    formatWhen: formatWhen,
    preview: preview,
    parseTagsInput: parseTagsInput,
    downloadText: downloadText,
    sha256Hex: sha256Hex,
    copyText: copyText,
    copyTextFallback: copyTextFallback,
    createFeedback: createFeedback,
    createRoomApi: createRoomApi,
    twoPane: twoPane,
  };
})(globalThis);
