/* eslint-disable */
/**
 * Reusable UI components: tables, modals, menus, toasts, key/value editors, segmented controls,
 * confirmation dialogs and the environment editor.
 */
(function () {
  'use strict';

  const Ely = window.Ely;
  const { el, clear } = Ely.dom;
  const { uid } = Ely.util;
  const { post } = Ely.transport;

  /* ---------------------------------- modal ------------------------------- */

  function openModal({ title, body, footer, wide = false, onClose }) {
    const root = document.getElementById('modal-root');
    const previousFocus = document.activeElement;
    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKeyDown, true);
      if (previousFocus && previousFocus.focus) {
        previousFocus.focus();
      }
      if (onClose) onClose();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === 'Tab') {
        // keep focus inside the dialog
        const focusable = Array.from(backdrop.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
          (node) => !node.disabled && node.offsetParent !== null
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    const dialog = el(
      'div',
      { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el(
        'div',
        { class: 'modal-header' },
        el('h3', null, title),
        el('button', { class: 'icon-button small', type: 'button', 'aria-label': 'Close', on: { click: close } }, '✕')
      ),
      el('div', { class: 'modal-body' }, body),
      footer ? el('div', { class: 'modal-footer' }, footer) : null
    );
    const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener('keydown', onKeyDown, true);
    root.appendChild(backdrop);
    const firstInput = dialog.querySelector('input, textarea, select');
    if (firstInput) {
      firstInput.focus();
      if (firstInput.select) firstInput.select();
    } else {
      const firstButton = dialog.querySelector('.modal-footer button, button');
      if (firstButton) firstButton.focus();
    }
    return { close, dialog };
  }

  function confirmDialog({ title, message, confirmLabel = 'Delete', danger = true }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(value);
      };
      const modal = openModal({
        title,
        body: el('p', { class: 'panel-hint' }, message),
        footer: [
          el('button', { class: 'button ghost', type: 'button', on: { click: () => finish(false) } }, 'Cancel'),
          el(
            'button',
            { class: `button ${danger ? 'danger' : 'primary'}`, type: 'button', on: { click: () => finish(true) } },
            confirmLabel
          )
        ],
        onClose: () => finish(false)
      });
    });
  }

  function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Save', validate }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        modal.close();
        resolve(result);
      };
      const input = el('input', { type: 'text', value, placeholder, 'aria-label': label });
      const error = el('div', { class: 'field-hint', style: { color: 'var(--error)' } }, '');
      const submit = () => {
        const text = input.value.trim();
        if (validate) {
          const problem = validate(text);
          if (problem) {
            error.textContent = problem;
            input.focus();
            return;
          }
        }
        finish(text);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        }
      });
      const modal = openModal({
        title,
        body: el('div', { class: 'field' }, el('label', null, label), input, error),
        footer: [
          el('button', { class: 'button ghost', type: 'button', on: { click: () => finish(null) } }, 'Cancel'),
          el('button', { class: 'button primary', type: 'button', on: { click: submit } }, confirmLabel)
        ],
        onClose: () => finish(null)
      });
    });
  }

  /* ---------------------------------- toast ------------------------------- */

  function toast(message, level = 'info', durationMs = 3800) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const node = el(
      'div',
      { class: 'toast', dataset: { level }, role: 'status' },
      el('span', null, String(message))
    );
    root.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 160ms ease';
      setTimeout(() => node.remove(), 200);
    }, durationMs);
  }

  /* ---------------------------------- menu -------------------------------- */

  let activeMenu = null;

  function closeMenu() {
    if (activeMenu) {
      activeMenu.remove();
      activeMenu = null;
    }
  }

  function showMenu(anchor, items, options = {}) {
    closeMenu();
    const menu = el('div', { class: options.className || 'menu context-menu', role: 'menu' });
    for (const item of items) {
      if (item.separator) {
        menu.appendChild(el('div', { class: 'menu-separator' }));
        continue;
      }
      if (item.label && item.heading) {
        menu.appendChild(el('div', { class: 'menu-label' }, item.label));
        continue;
      }
      const button = el(
        'button',
        {
          class: `menu-item ${item.danger ? 'danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          on: {
            click: (event) => {
              event.stopPropagation();
              closeMenu();
              item.onSelect();
            }
          }
        },
        el('span', null, item.label),
        item.hint ? el('span', { class: 'menu-hint' }, item.hint) : null
      );
      menu.appendChild(button);
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = options.alignRight ? rect.right - menuRect.width : rect.left;
    let top = rect.bottom + 6;
    if (left + menuRect.width > window.innerWidth - 8) {
      left = window.innerWidth - menuRect.width - 8;
    }
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menuRect.height - 6);
    }
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${top}px`;
    activeMenu = menu;
    const dismiss = (event) => {
      if (menu.contains(event.target)) return;
      closeMenu();
      document.removeEventListener('mousedown', dismiss, true);
    };
    setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
    return menu;
  }

  /* ------------------------------ kv editor ------------------------------- */

  /**
   * Editable key/value table. Calls `onChange(rows)` on every edit; row ids are stable so focus is
   * preserved between renders (the caller re-renders in place only when necessary).
   */
  function keyValueEditor({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', addLabel = 'Add row', showDescription = false, valueType = 'text', allowFiles = false, onPickFile }) {
    const table = el('table', { class: 'kv-table' });
    const tbody = el('tbody');
    const headers = [el('th', null, ''), el('th', null, keyPlaceholder), el('th', null, valuePlaceholder)];
    if (showDescription) headers.push(el('th', null, 'Description'));
    if (allowFiles) headers.push(el('th', null, 'Type'));
    headers.push(el('th', null, ''));
    table.appendChild(el('thead', null, el('tr', null, headers)));
    table.appendChild(tbody);

    const commit = () => onChange(rows.filter((row) => row.key !== '' || row.value !== '' || rows.length === 1));

    function render() {
      clear(tbody);
      for (const row of rows) {
        const tr = el('tr');
        tr.appendChild(
          el(
            'td',
            { class: 'check' },
            el('input', {
              class: 'checkbox',
              type: 'checkbox',
              checked: row.enabled !== false,
              'aria-label': 'Enable row',
              on: {
                change: (event) => {
                  row.enabled = event.target.checked;
                  commit();
                }
              }
            })
          )
        );
        tr.appendChild(
          el(
            'td',
            null,
            el('input', {
              type: 'text',
              value: row.key,
              placeholder: keyPlaceholder,
              spellcheck: false,
              'aria-label': `${keyPlaceholder}`,
              on: {
                input: debounce((event) => {
                  row.key = event.target.value;
                  commit();
                }, 180)
              }
            })
          )
        );
        const valueCell = el('td');
        if (allowFiles && row.type === 'file') {
          valueCell.appendChild(
            el(
              'div',
              { class: 'input-with-button' },
              el('input', { type: 'text', value: row.filePath || '', placeholder: 'No file selected', readonly: true }),
              el(
                'button',
                {
                  class: 'button secondary',
                  type: 'button',
                  on: {
                    click: async () => {
                      const picked = await onPickFile();
                      if (picked) {
                        row.filePath = picked;
                        commit();
                        render();
                      }
                    }
                  }
                },
                'File…'
              )
            )
          );
        } else {
          valueCell.appendChild(
            el('input', {
              type: valueType === 'password' ? 'password' : 'text',
              value: row.value,
              placeholder: valuePlaceholder,
              spellcheck: false,
              'aria-label': valuePlaceholder,
              on: {
                input: debounce((event) => {
                  row.value = event.target.value;
                  commit();
                }, 180)
              }
            })
          );
        }
        tr.appendChild(valueCell);
        if (showDescription) {
          tr.appendChild(
            el(
              'td',
              null,
              el('input', {
                type: 'text',
                value: row.description || '',
                placeholder: 'Description',
                'aria-label': 'Description',
                on: {
                  input: debounce((event) => {
                    row.description = event.target.value;
                    commit();
                  }, 180)
                }
              })
            )
          );
        }
        if (allowFiles) {
          tr.appendChild(
            el(
              'td',
              null,
              el(
                'select',
                {
                  'aria-label': 'Row type',
                  on: {
                    change: (event) => {
                      row.type = event.target.value;
                      commit();
                      render();
                    }
                  }
                },
                el('option', { value: 'text', selected: row.type !== 'file' }, 'Text'),
                el('option', { value: 'file', selected: row.type === 'file' }, 'File')
              )
            )
          );
        }
        tr.appendChild(
          el(
            'td',
            { class: 'actions' },
            el(
              'button',
              {
                class: 'row-remove',
                type: 'button',
                title: 'Remove row',
                'aria-label': 'Remove row',
                on: {
                  click: () => {
                    const index = rows.indexOf(row);
                    if (index >= 0) rows.splice(index, 1);
                    if (!rows.length) rows.push(Ely.models.newRow());
                    commit();
                    render();
                  }
                }
              },
              '✕'
            )
          )
        );
        tbody.appendChild(tr);
      }
    }

    render();

    const addButton = el(
      'button',
      {
        class: 'add-row-button',
        type: 'button',
        on: {
          click: () => {
            rows.push(Ely.models.newRow());
            render();
            const inputs = tbody.querySelectorAll('tr:last-child input[type="text"]');
            if (inputs.length) inputs[0].focus();
          }
        }
      },
      `+ ${addLabel}`
    );

    const wrapper = el('div', null, table, addButton);
    return { node: wrapper, rerender: render, rows };
  }

  function debounce(fn, wait) {
    let timer;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  /* ------------------------------ segmented ------------------------------- */

  function segmented(options, value, onChange) {
    const group = el('div', { class: 'segmented', role: 'tablist' });
    for (const option of options) {
      group.appendChild(
        el(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: option.value === value ? 'is-active' : '',
            'aria-selected': option.value === value ? 'true' : 'false',
            on: {
              click: () => {
                onChange(option.value);
              }
            }
          },
          option.label
        )
      );
    }
    return group;
  }

  /* -------------------------- environment editor -------------------------- */

  function environmentEditor(environment, onSave, options = {}) {
    const rows = environment.variables.length
      ? environment.variables.map((variable) => ({
          id: variable.id || uid(),
          key: variable.key || '',
          value: variable.value || '',
          enabled: variable.enabled !== false,
          secret: Boolean(variable.secret),
          hasValue: Boolean(variable.hasValue)
        }))
      : [];
    if (!rows.length) {
      rows.push({ id: uid(), key: '', value: '', enabled: true, secret: false, hasValue: false });
    }

    const table = el('table', { class: 'env-editor-table' });
    const tbody = el('tbody');
    table.appendChild(
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', null, ''),
          el('th', null, 'Variable'),
          el('th', null, 'Value'),
          el('th', null, 'Secret'),
          el('th', null, '')
        )
      )
    );
    table.appendChild(tbody);

    function renderRows() {
      clear(tbody);
      rows.forEach((row, index) => {
        const tr = el('tr');
        tr.appendChild(
          el(
            'td',
            null,
            el('input', {
              class: 'checkbox',
              type: 'checkbox',
              checked: row.enabled,
              'aria-label': 'Enabled',
              on: {
                change: (event) => {
                  row.enabled = event.target.checked;
                }
              }
            })
          )
        );
        tr.appendChild(
          el(
            'td',
            null,
            el('input', {
              type: 'text',
              value: row.key,
              placeholder: 'variableName',
              spellcheck: false,
              'aria-label': 'Variable name',
              on: {
                input: (event) => {
                  row.key = event.target.value;
                }
              }
            })
          )
        );
        tr.appendChild(
          el(
            'td',
            null,
            el('input', {
              type: row.secret ? 'password' : 'text',
              value: row.value,
              placeholder: row.secret && row.hasValue ? '•••• stored securely' : 'value',
              spellcheck: false,
              'aria-label': 'Value',
              on: {
                input: (event) => {
                  row.value = event.target.value;
                }
              }
            })
          )
        );
        tr.appendChild(
          el(
            'td',
            null,
            el(
              'label',
              { class: 'secret-toggle', title: 'Store this value in the OS keychain' },
              el('input', {
                type: 'checkbox',
                checked: row.secret,
                on: {
                  change: (event) => {
                    row.secret = event.target.checked;
                    renderRows();
                  }
                }
              }),
              row.secret ? 'secret' : 'plain'
            )
          )
        );
        tr.appendChild(
          el(
            'td',
            { class: 'actions' },
            el(
              'button',
              {
                class: 'row-remove',
                type: 'button',
                style: { visibility: 'visible' },
                title: 'Remove variable',
                'aria-label': 'Remove variable',
                on: {
                  click: () => {
                    if (row.id && row.secret && row.hasValue) {
                      post({ type: 'environment:clear-secret', payload: { environmentId: environment.id, variableId: row.id } });
                    }
                    rows.splice(index, 1);
                    if (!rows.length) rows.push({ id: uid(), key: '', value: '', enabled: true, secret: false, hasValue: false });
                    renderRows();
                  }
                }
              },
              '✕'
            )
          )
        );
        tbody.appendChild(tr);
      });
    }
    renderRows();

    const body = el(
      'div',
      null,
      el(
        'div',
        { class: 'info-callout' },
        Ely.dom.svgIcon('M12 8h.01M11 12h1v4h1', '0 0 24 24'),
        el('span', null, 'Use variables as', el('code', null, '{{name}}'), ' in URLs, headers, bodies and auth fields. Secret values are stored in SecretStorage and are never exported or shown.')
      ),
      table,
      el(
        'button',
        {
          class: 'add-row-button',
          type: 'button',
          on: {
            click: () => {
              rows.push({ id: uid(), key: '', value: '', enabled: true, secret: false, hasValue: false });
              renderRows();
            }
          }
        },
        '+ Add variable'
      )
    );

    const modal = openModal({
      title: `Edit environment · ${environment.name}`,
      body,
      wide: true,
      footer: [
        el('button', { class: 'button ghost', type: 'button', on: { click: () => modal.close() } }, 'Cancel'),
        el(
          'button',
          {
            class: 'button primary',
            type: 'button',
            on: {
              click: () => {
                const payload = rows
                  .filter((row) => row.key.trim())
                  .map((row) => ({ id: row.id, key: row.key.trim(), value: row.secret ? row.value : row.value, enabled: row.enabled, secret: row.secret }));
                onSave(payload);
                modal.close();
              }
            }
          },
          'Save environment'
        )
      ]
    });
    return modal;
  }

  Ely.ui = {
    openModal,
    confirmDialog,
    promptDialog,
    toast,
    showMenu,
    closeMenu,
    keyValueEditor,
    segmented,
    environmentEditor
  };
})();
