import { Component } from '../../core/Component.js';
import { h, clear } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { HOUR, fromInputValue, toInputValue } from '../../core/dates.js';

// What the + menu offers. Add or remove a line to change the menu.
//   ask      'title' = ask for a name first; 'deadline' = name + deadline; 'block' = name + From + To (both required);
//            absent = act at once
export const ADD_OPTIONS = [
  { id: 'folder', kind: 'folder', icon: 'folder', label: 'Folder', hint: 'A course, project or anything to group', ask: 'title' },
  { id: 'note', kind: 'note', icon: 'notes', label: 'Note', hint: 'Lecture notes, ideas, a topic you are reading' },
  { id: 'task', kind: 'task', icon: 'tasks', label: 'Task', hint: 'Something to do, from a start to an end', ask: 'block' },
  { id: 'assignment', kind: 'assignment', icon: 'assignment', label: 'Assignment', hint: 'Has a submission deadline', ask: 'deadline' },
  { id: 'files', icon: 'paperclip', label: 'Files & photos', hint: 'Copied into this folder', files: true },
];

// The round + button in the bottom-right corner of the canvas and the pop-up it opens,
// like a website chat widget. Step 1: pick what to add. Step 2 (if needed): name it.
export class AddMenu extends Component {
  /**
   * @param {object} opts
   * @param {() => string} opts.where              e.g. "CSC101" or "Home", shown in the header
   * @param {(o: {kind:string,title:string,deadline:string|null,start:string|null}) => void} opts.onCreate
   * @param {(() => void) | null} opts.onFiles     null hides the Files option
   * @param {(option: object) => object | null} [opts.adapt]  per place: return null to hide an option (no Assignment at
   *   the top level of Home) or a changed copy of it (a task inside an assignment is called a Step)
   */
  constructor(ctx, { where, onCreate, onFiles, adapt = (o) => o }) {
    super(ctx);
    this.where = where;
    this.onCreate = onCreate;
    this.onFiles = onFiles;
    this.adapt = adapt;
    this.isOpen = false;
    this.step = null; // the option being filled in, or null for the list
  }

  get options() { return ADD_OPTIONS.filter((o) => !o.files || this.onFiles).map((o) => this.adapt(o)).filter(Boolean); }

  build() {
    this.popEl = h('div', { class: 'add-pop', role: 'dialog', 'aria-label': 'Add' });
    this.fabEl = h('button', {
      class: 'fab', type: 'button', title: 'Add (Ctrl+N)', 'aria-label': 'Add',
      onClick: () => (this.isOpen ? this.close() : this.open()),
    }, icon('plus', 22));
    return h('div', { class: 'add-menu', 'data-keep-panel': true }, this.popEl, this.fabEl);
  }

  onMount() {
    // Click anywhere else or press Esc to close.
    this.listen(document, 'mousedown', (e) => { if (this.isOpen && !this.el.contains(e.target)) this.close(); });
    this.listen(document, 'keydown', (e) => { if (this.isOpen && e.key === 'Escape') this.close(); });
  }

  open() {
    this.isOpen = true;
    this.step = null;
    this.render();
    this.popEl.querySelector('button')?.focus();
  }

  close() {
    this.isOpen = false;
    this.step = null;
    this.render();
  }

  pick(option) {
    if (option.files) { this.close(); this.onFiles(); return; }
    if (!option.ask) { this.close(); this.onCreate({ kind: option.kind, title: '', deadline: null, start: null }); return; }
    this.step = option;
    this.render();
    this.popEl.querySelector('input')?.focus();
  }

  render() {
    this.el.classList.toggle('open', this.isOpen);
    this.fabEl.setAttribute('aria-expanded', String(this.isOpen));
    if (!this.isOpen) return; // keep the contents so the pop-up fades out instead of blinking empty
    clear(this.popEl);
    if (this.step) this.renderForm(this.step);
    else this.renderList();
  }

  renderList() {
    this.popEl.append(
      h('div', { class: 'add-head' },
        h('div', {}, h('div', { class: 'add-title' }, 'Add'), h('div', { class: 'add-sub' }, `to ${this.where()}`)),
        h('button', { class: 'icon-btn', type: 'button', title: 'Close', onClick: () => this.close() }, icon('close', 16))),
      h('div', { class: 'add-list' }, this.options.map((o) =>
        h('button', { class: 'add-option', type: 'button', onClick: () => this.pick(o) },
          h('span', { class: `add-icon k-${o.id}` }, icon(o.icon, 18)),
          h('span', { class: 'add-text' }, h('span', { class: 'add-label' }, o.label), h('span', { class: 'add-hint' }, o.hint))))));
  }

  renderForm(option) {
    const titleInput = h('input', { class: 'input', placeholder: `${option.label} name`, 'aria-label': 'Name' });
    const block = option.ask === 'block'; // a task: From and To, both required
    const mustHaveDue = option.kind === 'assignment' || block; // an assignment always has a deadline
    const dueInput = option.ask === 'deadline' || block
      ? h('input', { class: 'input', type: 'datetime-local', 'aria-label': block ? 'To' : 'Deadline' })
      : null;
    const startInput = block ? h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'From' }) : null;
    if (block) { // a useful start: the next full hour, for an hour
      const from = new Date(Math.ceil((Date.now() + 1) / HOUR) * HOUR);
      startInput.value = toInputValue(from);
      dueInput.value = toInputValue(new Date(from.getTime() + HOUR));
    }
    const errorEl = h('div', { class: 'field-error', role: 'alert', hidden: true });

    const submit = (e) => {
      e.preventDefault();
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }
      const due = dueInput ? fromInputValue(dueInput.value) : null;
      const start = startInput ? fromInputValue(startInput.value) : null;
      if (mustHaveDue && !due) { dueInput.focus(); return; }
      if (block && !start) { startInput.focus(); return; }
      if (block && start >= due) { errorEl.textContent = 'The start must be earlier than the end.'; errorEl.hidden = false; return; }
      this.close();
      this.onCreate({ kind: option.kind, title, deadline: due ? due.toISOString() : null, start: start ? start.toISOString() : null });
    };

    this.popEl.append(
      h('div', { class: 'add-head' },
        h('button', { class: 'icon-btn', type: 'button', title: 'Back', onClick: () => { this.step = null; this.render(); } }, icon('chevLeft', 16)),
        h('div', { class: 'add-title grow' }, `New ${option.label.toLowerCase()}`),
        h('button', { class: 'icon-btn', type: 'button', title: 'Close', onClick: () => this.close() }, icon('close', 16))),
      h('form', { class: 'add-form', onSubmit: submit },
        h('label', { class: 'add-field' }, h('span', {}, 'Name'), titleInput),
        startInput ? h('label', { class: 'add-field' }, h('span', {}, 'From'), startInput) : null,
        dueInput ? h('label', { class: 'add-field' }, h('span', {}, block ? 'To' : mustHaveDue ? 'Deadline' : 'Deadline (optional)'), dueInput) : null,
        errorEl,
        h('button', { class: 'btn btn-primary add-submit', type: 'submit' }, `Create ${option.label.toLowerCase()}`)));
  }
}
