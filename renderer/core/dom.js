// h('div', { class: 'x', onClick: fn }, child, child) -> HTMLElement
// Small helper so components build their markup without a framework.
const LIVE_PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const deferred = [];

  for (const [key, val] of Object.entries(attrs || {})) {
    if (val === null || val === undefined || val === false) continue;
    if (key === 'class') {
      el.className = val;
    } else if (key === 'style' && typeof val === 'object') {
      for (const [prop, v] of Object.entries(val)) el.style.setProperty(prop, v);
    } else if (key === 'html') {
      el.innerHTML = val; // only ever used with our own static icon strings
    } else if (key.startsWith('on') && typeof val === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), val);
    } else if (LIVE_PROPS.has(key)) {
      deferred.push([key, val]); // set after children exist (needed for <select>)
    } else {
      el.setAttribute(key, val === true ? '' : val);
    }
  }

  append(el, children);
  for (const [key, val] of deferred) el[key] = val;
  return el;
}

function append(el, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) child.forEach((c) => append(el, c));
  else if (child instanceof Node) el.appendChild(child);
  else el.appendChild(document.createTextNode(String(child)));
}

export function clear(el) {
  el.replaceChildren();
  return el;
}
