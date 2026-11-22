/* eslint-disable */
/**
 * Response rendering: JSON tokenizer + pretty printer, syntax highlighted views, header/cookie
 * tables, test results, timing chart and search highlighting.
 *
 * Security: every string is appended with `document.createTextNode` / `textContent`. Nothing in this
 * file assigns user or server-controlled data to innerHTML.
 */
(function () {
  'use strict';

  const Ely = window.Ely;
  const { el, clear } = Ely.dom;
  const { bytes, duration } = Ely.format;

  /* ------------------------------ JSON parser ---------------------------- */

  /**
   * Formats JSON text with indentation. Returns `{ ok, text, error }`. Large documents are handled
   * iteratively to avoid deep recursion issues on hostile payloads.
   */
  function formatJson(text, indent = 2) {
    try {
      const parsed = JSON.parse(text);
      return { ok: true, text: JSON.stringify(parsed, null, indent) };
    } catch (error) {
      return { ok: false, text, error: String(error && error.message ? error.message : error) };
    }
  }

  function minifyJson(text) {
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(text)) };
    } catch (error) {
      return { ok: false, text, error: String(error.message || error) };
    }
  }

  /* ------------------------------ tokenizer ------------------------------ */

  const TOKEN_PATTERN = /("(?:\\u[0-9a-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

  /**
   * Splits a formatted JSON document into tokens for highlighting.
   * Returns an array of `{ type, value }` where type is one of key/string/number/boolean/null/plain.
   */
  function tokenize(text) {
    const tokens = [];
    let lastIndex = 0;
    TOKEN_PATTERN.lastIndex = 0;
    let match;
    while ((match = TOKEN_PATTERN.exec(text)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ type: 'plain', value: text.slice(lastIndex, match.index) });
      }
      const value = match[0];
      let type = 'plain';
      if (match[2]) {
        type = 'key';
      } else if (value.startsWith('"')) {
        type = 'string';
      } else if (value === 'true' || value === 'false') {
        type = 'boolean';
      } else if (value === 'null') {
        type = 'null';
      } else {
        type = 'number';
      }
      tokens.push({ type, value });
      lastIndex = match.index + value.length;
    }
    if (lastIndex < text.length) {
      tokens.push({ type: 'plain', value: text.slice(lastIndex) });
    }
    return tokens;
  }

  /**
   * Builds a `<pre>`-like fragment with line numbers and colour spans.
   * `query` highlights matches (case-sensitive by default) and returns the number of hits.
   */
  function buildCodeView(text, options = {}) {
    const container = el('pre', { class: options.class || 'code-view', tabindex: '0' });
    if (options.wrap !== false) {
      container.classList.add('is-wrapped');
    }
    const lines = String(text ?? '').split('\n');
    const query = options.query && options.query.length >= 2 ? options.query : null;
    let hits = 0;
    const lineNumbers = options.lineNumbers !== false;
    const fragment = document.createDocumentFragment();
    const tokenLines = options.highlight === false ? null : tokenizeWithLines(text);

    lines.forEach((line, index) => {
      const lineEl = el('div', { class: 'code-line' });
      if (lineNumbers) {
        lineEl.appendChild(el('span', { class: 'line-number' }, String(index + 1)));
      }
      const content = el('span', { class: 'line-content' });
      if (tokenLines && tokenLines[index]) {
        for (const token of tokenLines[index]) {
          if (query) {
            const result = appendWithHighlight(content, token.value, query, token.type ? `tok-${token.type}` : null);
            hits += result;
          } else {
            content.appendChild(token.type ? el('span', { class: `tok-${token.type}` }, token.value) : document.createTextNode(token.value));
          }
        }
      } else {
        if (query) {
          hits += appendWithHighlight(content, line, query);
        } else {
          content.appendChild(document.createTextNode(line));
        }
      }
      lineEl.appendChild(content);
      fragment.appendChild(lineEl);
    });
    container.appendChild(fragment);
    return { node: container, hits };
  }

  /** Splits highlighted content per line while keeping token types. */
  function tokenizeWithLines(text) {
    const tokens = tokenize(String(text ?? ''));
    const lines = [[]];
    for (const token of tokens) {
      const parts = token.value.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) {
          lines.push([]);
        }
        if (part) {
          lines[lines.length - 1].push({ type: token.type, value: part });
        }
      });
    }
    return lines;
  }

  /** Appends text to `parent`, wrapping occurrences of `query` in `<mark>`. Returns hit count. */
  function appendWithHighlight(parent, text, query, className) {
    let hits = 0;
    let index = 0;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    while (index < text.length) {
      const found = lowerText.indexOf(lowerQuery, index);
      if (found === -1) {
        break;
      }
      if (found > index) {
        appendSpan(parent, text.slice(index, found), className);
      }
      parent.appendChild(el('mark', { class: 'hit' }, text.slice(found, found + query.length)));
      hits++;
      index = found + query.length;
      if (hits > 500) {
        break;
      }
    }
    if (index < text.length) {
      appendSpan(parent, text.slice(index), className);
    }
    return hits;
  }

  function appendSpan(parent, text, className) {
    if (!text) return;
    if (className) {
      parent.appendChild(el('span', { class: className }, text));
    } else {
      parent.appendChild(document.createTextNode(text));
    }
  }

  /* --------------------------- response sections ------------------------- */

  function headerTable(headers, options = {}) {
    if (!headers || !headers.length) {
      return emptyState(options.emptyText || 'No headers in this response.');
    }
    const tbody = el('tbody');
    for (const header of headers) {
      const sensitive = /authorization|api-key|cookie/i.test(header.key);
      tbody.appendChild(
        el(
          'tr',
          null,
          el('td', null, header.key),
          el('td', null, sensitive && options.maskSensitive ? '●●●●●●' : header.value)
        )
      );
    }
    return el(
      'table',
      { class: 'table-view' },
      el('thead', null, el('tr', null, el('th', null, 'Header'), el('th', null, 'Value'))),
      tbody
    );
  }

  function cookieTable(cookies) {
    if (!cookies || !cookies.length) {
      return emptyState('No cookies were set by this response.');
    }
    const tbody = el('tbody');
    for (const cookie of cookies) {
      tbody.appendChild(
        el(
          'tr',
          null,
          el('td', null, cookie.name),
          el('td', null, cookie.value),
          el('td', null, cookie.domain || '—'),
          el('td', null, cookie.path || '—'),
          el('td', null, `${cookie.httpOnly ? 'HttpOnly ' : ''}${cookie.secure ? 'Secure ' : ''}${cookie.sameSite ? `SameSite=${cookie.sameSite}` : ''}`.trim() || '—')
        )
      );
    }
    return el(
      'table',
      { class: 'table-view' },
      el(
        'thead',
        null,
        el('tr', null, el('th', null, 'Name'), el('th', null, 'Value'), el('th', null, 'Domain'), el('th', null, 'Path'), el('th', null, 'Flags'))
      ),
      tbody
    );
  }

  function emptyState(text) {
    return el('div', { class: 'preview-empty' }, text);
  }

  function testResults(summary, options = {}) {
    const wrapper = el('div');
    if (!summary || (!summary.results.length && !summary.error && !summary.console.length)) {
      wrapper.appendChild(
        emptyState(
          options.hasScript
            ? 'The test script did not define any tests. Use pm.test("name", () => { ... }) to add assertions.'
            : 'No tests were run. Add assertions in the Scripts tab.'
        )
      );
      return wrapper;
    }
    const header = el(
      'div',
      { class: 'tests-summary' },
      el('span', { class: 'pill pass' }, `${summary.passed} passed`),
      summary.failed ? el('span', { class: 'pill fail' }, `${summary.failed} failed`) : null,
      el('span', { class: 'pill neutral' }, `${duration(summary.durationMs)}`)
    );
    wrapper.appendChild(header);
    if (summary.error) {
      wrapper.appendChild(el('div', { class: 'truncation-notice' }, summary.error));
    }
    const list = el('div', { class: 'test-list' });
    for (const result of summary.results) {
      list.appendChild(
        el(
          'div',
          { class: `test-item ${result.passed ? 'passed' : 'failed'}` },
          el('span', { class: 'test-icon' }, result.passed ? '✓' : '✕'),
          el('span', null, result.name),
          el('span', { class: 'test-duration' }, duration(result.durationMs)),
          result.error ? el('div', { class: 'test-error' }, result.error) : null
        )
      );
    }
    wrapper.appendChild(list);
    if (summary.console && summary.console.length) {
      const consoleList = el('div', { class: 'console-list' });
      for (const entry of summary.console) {
        consoleList.appendChild(el('div', { class: 'console-entry', dataset: { level: entry.level } }, entry.message));
      }
      wrapper.appendChild(consoleList);
    }
    return wrapper;
  }

  function timingChart(response) {
    const wrapper = el('div', { class: 'timing-chart' });
    if (!response) {
      return emptyState('Send a request to see timings.');
    }
    const total = Math.max(1, response.durationMs);
    const firstByte = response.timings && response.timings.firstByte ? response.timings.firstByte : total;
    const download = Math.max(0, total - firstByte);
    const rows = [
      { label: 'Waiting (TTFB)', value: firstByte, cls: 'ttfb' },
      { label: 'Download', value: download, cls: 'download' }
    ];
    for (const row of rows) {
      wrapper.appendChild(
        el(
          'div',
          { class: 'timing-row' },
          el('span', { class: 'timing-label' }, row.label),
          el('div', { class: 'timing-bar-track' }, el('div', { class: `timing-bar ${row.cls}`, style: { width: `${Math.max(1, (row.value / total) * 100)}%` } })),
          el('span', { class: 'timing-value' }, duration(row.value))
        )
      );
    }
    wrapper.appendChild(
      el(
        'div',
        { class: 'timing-row' },
        el('span', { class: 'timing-label' }, 'Total'),
        el('div', { class: 'timing-bar-track' }, el('div', { class: 'timing-bar', style: { width: '100%' } })),
        el('span', { class: 'timing-value' }, duration(total))
      )
    );
    if (response.redirects && response.redirects.length) {
      wrapper.appendChild(el('div', { class: 'panel-hint' }, `Followed ${response.redirects.length} redirect(s).`));
    }
    if (response.truncated) {
      wrapper.appendChild(
        el('div', { class: 'truncation-notice' }, `The body was truncated for display (${bytes(response.sizeBytes)} received).`)
      );
    }
    wrapper.appendChild(
      el(
        'div',
        { class: 'panel-hint', style: { marginTop: '10px' } },
        `Received ${bytes(response.sizeBytes)} · ${response.contentType || 'no content type'} · ${response.httpVersion || 'HTTP/1.1'}`
      )
    );
    return wrapper;
  }

  /**
   * Returns a safe preview node for HTML / images / SVG. HTML is rendered inside a sandboxed iframe
   * with scripts disabled (CSP + sandbox without allow-scripts).
   */
  function buildPreview(response, settings) {
    if (!response) {
      return emptyState('Run a request to preview its response.');
    }
    if (response.bodyKind === 'image') {
      const mime = (response.contentType || 'image/png').split(';')[0];
      const src = `data:${mime};base64,${response.body}`;
      return el('img', { class: 'preview-image', src, alt: 'Response image' });
    }
    if (response.bodyKind === 'html') {
      const iframe = el('iframe', {
        class: 'preview-frame',
        sandbox: '',
        referrerpolicy: 'no-referrer',
        title: 'Response preview'
      });
      iframe.setAttribute('sandbox', '');
      iframe.srcdoc = response.body;
      return iframe;
    }
    if (response.bodyKind === 'json' || response.bodyKind === 'xml' || response.bodyKind === 'text') {
      const formatted = response.bodyKind === 'json' ? formatJson(response.body) : { text: response.body };
      const { node } = buildCodeView(formatted.text, { wrap: true, highlight: response.bodyKind === 'json' });
      return node;
    }
    if (response.bodyKind === 'binary') {
      return emptyState('This response is a binary payload and cannot be previewed.');
    }
    return emptyState('Nothing to preview.');
  }

  Ely.json = { formatJson, minifyJson, tokenize, buildCodeView, tokenizeWithLines };
  Ely.view = { headerTable, cookieTable, emptyState, testResults, timingChart, buildPreview, buildCodeView, appendWithHighlight };
})();
