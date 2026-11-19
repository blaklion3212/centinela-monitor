'use strict';
/*
 * DOM mínimo para probar vistas del navegador sin dependencias (no hay jsdom en el proyecto). Solo implementa lo que usan
 * js/views/alerts.js y js/views/settings.js: innerHTML (analizado a un árbol real, de modo que el HTML inyectado se ve como
 * elementos y no como texto), selectores compuestos (etiqueta, #id, .clase, [atributo] y [atributo="valor"]), closest,
 * eventos con propagación hacia los padres, y las propiedades disabled / hidden / checked / value.
 */
var VOID = { input: 1, br: 1, hr: 1, img: 1, meta: 1, link: 1 };

function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
}
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }

function parseSel(sel) {
  var c = { tag: null, id: null, classes: [], attrs: [] }, re = /([#.]?)([-\w]+)|\[([-\w:]+)(?:=("[^"]*"|'[^']*'|[^\]]*))?\]/g, m;
  while ((m = re.exec(sel))) {
    if (m[3]) { var v = m[4]; if (v !== undefined && /^["']/.test(v)) v = v.slice(1, -1); c.attrs.push([m[3], v]); }
    else if (m[1] === '#') c.id = m[2];
    else if (m[1] === '.') c.classes.push(m[2]);
    else c.tag = m[2].toLowerCase();
  }
  return c;
}

function Node(tag) {
  this.tag = tag; this.attrs = {}; this.children = []; this.parent = null; this.text = null;
  this.listeners = {}; this._value = undefined; this._checked = undefined; this.focused = 0;
}
Node.prototype = {
  get parentNode() { return this.parent; },
  getAttribute: function (n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
  setAttribute: function (n, v) { this.attrs[n] = String(v); },
  removeAttribute: function (n) { delete this.attrs[n]; },
  hasAttribute: function (n) { return Object.prototype.hasOwnProperty.call(this.attrs, n); },
  get id() { return this.attrs.id || ''; },
  get className() { return this.attrs['class'] || ''; },
  get hidden() { return this.hasAttribute('hidden'); },
  set hidden(v) { if (v) this.attrs.hidden = ''; else delete this.attrs.hidden; },
  get disabled() { return this.hasAttribute('disabled'); },
  set disabled(v) { if (v) this.attrs.disabled = ''; else delete this.attrs.disabled; },
  get checked() { return this._checked !== undefined ? this._checked : this.hasAttribute('checked'); },
  set checked(v) { this._checked = !!v; },
  get value() { return this._value !== undefined ? this._value : (this.attrs.value !== undefined ? this.attrs.value : ''); },
  set value(v) { this._value = String(v); },
  get type() { return this.attrs.type || ''; },
  get textContent() { return this.text !== null ? this.text : this.children.map(function (c) { return c.textContent; }).join(''); },
  get innerHTML() { return this.children.map(serialize).join(''); },
  set innerHTML(html) { this.children = []; parseInto(this, String(html)); },
  insertAdjacentHTML: function (where, html) {
    var tmp = new Node('div'); parseInto(tmp, html);
    var kids = tmp.children; kids.forEach(function (k) { k.parent = this; }, this);
    this.children = where === 'afterbegin' ? kids.concat(this.children) : this.children.concat(kids);
  },
  removeChild: function (n) { var i = this.children.indexOf(n); if (i >= 0) { this.children.splice(i, 1); n.parent = null; } return n; },
  addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
  focus: function () { this.focused++; },
  matches: function (sel) {
    var c = parseSel(sel), self = this;
    if (c.tag && this.tag !== c.tag) return false;
    if (c.id && this.id !== c.id) return false;
    if (!c.classes.every(function (k) { return (' ' + self.className + ' ').indexOf(' ' + k + ' ') >= 0; })) return false;
    return c.attrs.every(function (a) { return self.hasAttribute(a[0]) && (a[1] === undefined || self.attrs[a[0]] === a[1]); });
  },
  closest: function (sel) { for (var n = this; n && n.tag; n = n.parent) if (n.matches(sel)) return n; return null; },
  // Admite compuestos y el combinador descendiente (espacio): '[data-status] [data-state]'.
  querySelectorAll: function (sel) {
    var partes = String(sel).trim().split(/\s+(?![^\[]*\])/), ultima = partes[partes.length - 1], raiz = this, out = [];
    function cumple(n) {
      if (!n.matches(ultima)) return false;
      var i = partes.length - 2, a = n.parent;
      while (i >= 0 && a && a.tag) { if (a.matches(partes[i])) i--; a = a.parent; }
      return i < 0;
    }
    (function rec(n) { n.children.forEach(function (c) { if (c.tag && cumple(c)) out.push(c); rec(c); }); })(raiz);
    return out;
  },
  querySelector: function (sel) { return this.querySelectorAll(sel)[0] || null; },
  // Ancestros ocultos: un elemento con hidden en cualquier ancestro no es visible.
  isVisible: function () { for (var n = this; n && n.tag; n = n.parent) if (n.hidden) return false; return true; }
};

function serialize(n) {
  if (!n.tag) return escText(n.text);
  var a = Object.keys(n.attrs).map(function (k) { return ' ' + k + (n.attrs[k] === '' ? '' : '="' + escAttr(n.attrs[k]) + '"'); }).join('');
  return VOID[n.tag] ? '<' + n.tag + a + '>' : '<' + n.tag + a + '>' + n.children.map(serialize).join('') + '</' + n.tag + '>';
}

function textNode(t) { var n = new Node(null); n.text = decode(t); return n; }

function parseInto(root, html) {
  var re = /<!--[\s\S]*?-->|<\/([a-zA-Z][-\w]*)\s*>|<([a-zA-Z][-\w]*)((?:\s+[-\w:]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</g;
  var stack = [root], m;
  function top() { return stack[stack.length - 1]; }
  while ((m = re.exec(html))) {
    var tk = m[0];
    if (tk.indexOf('<!--') === 0) continue;
    if (m[1]) { // cierre
      for (var i = stack.length - 1; i > 0; i--) if (stack[i].tag === m[1].toLowerCase()) { stack.length = i; break; }
    } else if (m[2]) {
      var n = new Node(m[2].toLowerCase()), ar = /([-\w:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, am;
      while ((am = ar.exec(m[3] || ''))) {
        var v = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
        n.attrs[am[1]] = v === undefined ? '' : decode(v);
      }
      n.parent = top(); top().children.push(n);
      if (!VOID[n.tag] && !/\/>$/.test(tk)) stack.push(n);
    } else {
      var t = textNode(tk); t.parent = top(); top().children.push(t);
    }
  }
}

function elemento() { var n = new Node('section'); return n; }

// Propaga un evento desde node hacia sus padres. Devuelve el evento.
function fire(node, type, props) {
  var e = Object.assign({ type: type, target: node, defaultPrevented: false, preventDefault: function () { e.defaultPrevented = true; } }, props || {});
  for (var n = node; n; n = n.parent) {
    (n.listeners[type] || []).forEach(function (fn) { fn(e); });
  }
  return e;
}
// Clic como en un navegador: los botones deshabilitados no responden y un botón submit envía su formulario.
function click(node) {
  if (!node) throw new Error('click: elemento inexistente');
  if (node.disabled) return null;
  var e = fire(node, 'click');
  if (!e.defaultPrevented && node.tag === 'button' && node.type === 'submit') {
    var f = node.closest('form'); if (f) fire(f, 'submit');
  }
  return e;
}
function keydown(node, key) { return fire(node, 'keydown', { key: key }); }

// Espera a que se resuelvan las promesas encadenadas (fetch simulado y manejadores).
function settle() {
  var p = Promise.resolve();
  for (var i = 0; i < 6; i++) p = p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  return p;
}

module.exports = { Node: Node, elemento: elemento, fire: fire, click: click, keydown: keydown, settle: settle };
