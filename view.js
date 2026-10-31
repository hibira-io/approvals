// Markup of the inbox and card, written once against a tiny element helper
// so React (createElement) and Vue (h) render the same thing:
// el(tag, { class, onClick, onInput, value, ... }, ...children).

import { format } from './locales.js';

const ICONS = {
  check: 'M4 10.5l4 4 8-9',
  x: 'M5 5l10 10M15 5L5 15',
  edit: 'M4 16h3l8.5-8.5-3-3L4 13v3zM11 6l3 3',
  back: 'M12 4l-6 6 6 6',
  send: 'M3 10l14-6-6 14-2-6-6-2z',
  retry: 'M4 10a6 6 0 1 0 2-4.5M4 3v3.5h3.5',
};

function icon(el, name) {
  return el(
    'svg',
    { class: 'hb-ap-icon', viewBox: '0 0 20 20', width: 16, height: 16, 'aria-hidden': 'true', fill: 'none' },
    el('path', { d: ICONS[name], stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
  );
}

function initials(name) {
  return String(name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0].toUpperCase())
    .join('');
}

function avatars(el, people, label) {
  if (!people.length) return null;
  return el(
    'div',
    { class: 'hb-ap-people', title: `${label}: ${people.map((p) => p.name ?? p.id).join(', ')}` },
    ...people.slice(0, 4).map((p) =>
      p.avatar
        ? el('img', { key: p.id, class: 'hb-ap-avatar', src: p.avatar, alt: p.name ?? p.id })
        : el('span', { key: p.id, class: 'hb-ap-avatar', 'aria-label': p.name ?? p.id }, initials(p.name ?? p.id)),
    ),
    people.length > 4 ? el('span', { class: 'hb-ap-avatar hb-ap-avatar--more' }, `+${people.length - 4}`) : null,
  );
}

function ago(iso, locale) {
  if (!iso) return '';
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const steps = [
    [60, 'second'],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [Infinity, 'day', 86400],
  ];
  try {
    const rtf = new Intl.RelativeTimeFormat(locale || undefined, { numeric: 'auto', style: 'short' });
    for (const [limit, unit, div = 1] of steps) if (Math.abs(s) < limit) return rtf.format(Math.round(s / div), unit);
  } catch {
    return '';
  }
  return '';
}

function badge(el, status, t) {
  return el('span', { class: `hb-ap-badge hb-ap-badge--${status}` }, t.status[status] ?? status);
}

function button(el, { kind = 'plain', onClick, disabled, label, iconName, title }) {
  return el(
    'button',
    { type: 'button', class: `hb-ap-btn hb-ap-btn--${kind}`, onClick, disabled, title },
    iconName ? icon(el, iconName) : null,
    label ? el('span', null, label) : null,
  );
}

function callView(el, call, s, inbox, t) {
  const pending = s.active.status === 'pending';
  const editing = s.editing?.callId === call.id ? s.editing : null;
  const rejecting = s.rejecting?.callId === call.id ? s.rejecting : null;
  const shown = call.decision === 'edit' ? call.edited_input : call.input;
  const body = [];

  body.push(
    el(
      'div',
      { class: 'hb-ap-call__head' },
      el('code', { class: 'hb-ap-call__tool' }, call.tool),
      call.decision
        ? el(
            'span',
            { class: `hb-ap-chip hb-ap-chip--${call.decision}` },
            icon(el, call.decision === 'reject' ? 'x' : call.decision === 'edit' ? 'edit' : 'check'),
            t.decision[call.decision],
            call.decided_by ? el('span', { class: 'hb-ap-muted' }, ' ' + format(t.decidedBy, { name: call.decided_by })) : null,
          )
        : null,
    ),
  );

  if (editing) {
    body.push(
      el('textarea', {
        class: 'hb-ap-textarea hb-ap-textarea--code' + (editing.invalid ? ' is-invalid' : ''),
        value: editing.text,
        rows: Math.min(14, Math.max(4, editing.text.split('\n').length + 1)),
        spellcheck: false,
        'aria-label': t.input,
        onInput: (e) => inbox.setEditText(e.target.value),
      }),
      editing.invalid ? el('p', { class: 'hb-ap-error' }, t.invalidJson) : null,
      el(
        'div',
        { class: 'hb-ap-actions' },
        button(el, { label: t.cancel, onClick: () => inbox.cancelForm(), disabled: s.busy }),
        button(el, { kind: 'primary', label: t.saveEdit, iconName: 'check', onClick: () => inbox.saveEdit(), disabled: s.busy }),
      ),
    );
  } else {
    body.push(el('pre', { class: 'hb-ap-input', 'aria-label': t.input }, JSON.stringify(shown ?? null, null, 2)));
  }

  if (call.reason) body.push(el('p', { class: 'hb-ap-reason' }, call.reason));

  if (rejecting) {
    body.push(
      el('textarea', {
        class: 'hb-ap-textarea',
        value: rejecting.text,
        rows: 2,
        placeholder: t.reasonPlaceholder,
        'aria-label': t.reasonPlaceholder,
        onInput: (e) => inbox.setRejectText(e.target.value),
      }),
      el(
        'div',
        { class: 'hb-ap-actions' },
        button(el, { label: t.cancel, onClick: () => inbox.cancelForm(), disabled: s.busy }),
        button(el, { kind: 'danger', label: t.reject, iconName: 'x', onClick: () => inbox.saveReject(), disabled: s.busy }),
      ),
    );
  }

  if (pending && !editing && !rejecting) {
    body.push(
      call.decision
        ? el('div', { class: 'hb-ap-actions' }, button(el, { label: t.change, onClick: () => inbox.undo(call.id), disabled: s.busy }))
        : el(
            'div',
            { class: 'hb-ap-actions' },
            button(el, { label: t.edit, iconName: 'edit', onClick: () => inbox.startEdit(call), disabled: s.busy }),
            button(el, { kind: 'danger-soft', label: t.reject, iconName: 'x', onClick: () => inbox.startReject(call), disabled: s.busy }),
            button(el, { kind: 'primary', label: t.approve, iconName: 'check', onClick: () => inbox.decide(call.id, 'approve'), disabled: s.busy }),
          ),
    );
  }

  return el('li', { key: call.id, class: 'hb-ap-call' + (call.decision ? ` is-${call.decision}` : '') }, ...body);
}

/** One request with its calls and decision buttons. */
export function renderCard(el, s, inbox, t, opts = {}) {
  const r = s.active;
  if (!r) {
    return el(
      'article',
      { class: 'hb-ap-card hb-ap-card--empty' },
      s.error ? el('p', { class: 'hb-ap-error' }, t.error) : el('p', { class: 'hb-ap-muted' }, t.loading),
    );
  }
  const undecided = r.calls.filter((c) => !c.decision).length;
  const others = s.viewers.filter((v) => String(v.id) !== String(opts.me ?? ''));
  const footer = [];
  if (r.status === 'pending') {
    footer.push(
      el('span', { class: 'hb-ap-muted' }, undecided ? format(t.undecided, { count: undecided }) : ''),
      el(
        'div',
        { class: 'hb-ap-actions' },
        undecided
          ? [
              r.calls.length > 1 ? button(el, { kind: 'danger-soft', label: t.rejectAll, onClick: () => inbox.decideAll('reject'), disabled: s.busy }) : null,
              r.calls.length > 1
                ? button(el, { kind: 'primary', label: t.approveAll, iconName: 'check', onClick: () => inbox.decideAll('approve'), disabled: s.busy })
                : null,
            ]
          : button(el, { kind: 'primary', label: t.send, iconName: 'send', onClick: () => inbox.send(), disabled: s.busy }),
      ),
    );
  }
  if (r.status === 'failed') {
    footer.push(
      el('span', { class: 'hb-ap-error' }, r.error ?? ''),
      el('div', { class: 'hb-ap-actions' }, button(el, { kind: 'primary', label: t.retry, iconName: 'retry', onClick: () => inbox.retry(), disabled: s.busy })),
    );
  }

  return el(
    'article',
    { class: 'hb-ap-card', 'aria-busy': s.busy ? 'true' : 'false' },
    el(
      'header',
      { class: 'hb-ap-card__head' },
      opts.onBack ? button(el, { kind: 'icon', iconName: 'back', onClick: opts.onBack, title: t.back }) : null,
      el('span', { class: 'hb-ap-agent', 'aria-hidden': 'true' }, initials(r.agent)),
      el(
        'div',
        { class: 'hb-ap-card__title' },
        el('strong', null, r.title || r.calls.map((c) => c.tool).join(', ')),
        el('span', { class: 'hb-ap-muted' }, `${r.agent} · ${ago(r.created_at, opts.locale)}`),
      ),
      avatars(el, others, t.alsoHere),
      badge(el, r.status, t),
    ),
    el('ol', { class: 'hb-ap-calls' }, ...r.calls.map((c) => callView(el, c, s, inbox, t))),
    s.actionError ? el('p', { class: 'hb-ap-error', role: 'alert' }, s.actionError.message || t.error) : null,
    footer.length ? el('footer', { class: 'hb-ap-card__foot' }, ...footer) : null,
  );
}

/** List of requests on the left, the open one on the right (stacked on phones). */
export function renderInbox(el, s, inbox, t, opts = {}) {
  const tabs = ['pending', 'done', 'all'];
  const list = s.loading
    ? el('p', { class: 'hb-ap-muted hb-ap-pad' }, t.loading)
    : s.error && !s.requests.length
      ? el('p', { class: 'hb-ap-error hb-ap-pad' }, t.error)
      : !s.requests.length
        ? el('p', { class: 'hb-ap-empty' }, icon(el, 'check'), t.empty)
        : el(
            'ul',
            { class: 'hb-ap-list' },
            ...s.requests.map((r) =>
              el(
                'li',
                { key: r.id },
                el(
                  'button',
                  {
                    type: 'button',
                    class: 'hb-ap-row' + (r.id === s.activeId ? ' is-active' : ''),
                    onClick: () => inbox.open(r.id),
                    'aria-current': r.id === s.activeId ? 'true' : undefined,
                  },
                  el('span', { class: 'hb-ap-agent', 'aria-hidden': 'true' }, initials(r.agent)),
                  el(
                    'span',
                    { class: 'hb-ap-row__text' },
                    el('strong', null, r.title || r.calls.map((c) => c.tool).join(', ')),
                    el('span', { class: 'hb-ap-muted' }, `${r.agent} · ${ago(r.created_at, opts.locale)}`),
                  ),
                  badge(el, r.status, t),
                ),
              ),
            ),
          );

  const others = s.reviewers.filter((v) => String(v.id) !== String(opts.me ?? ''));
  return el(
    'section',
    { class: 'hb-ap' + (s.activeId ? ' is-open' : '') },
    el(
      'header',
      { class: 'hb-ap__head' },
      el('h2', { class: 'hb-ap__title' }, t.title),
      avatars(el, others, format(t.online, { count: others.length })),
      el(
        'div',
        { class: 'hb-ap-tabs', role: 'tablist' },
        ...tabs.map((tab) =>
          el(
            'button',
            {
              key: tab,
              type: 'button',
              role: 'tab',
              'aria-selected': s.status === tab ? 'true' : 'false',
              class: 'hb-ap-tab' + (s.status === tab ? ' is-active' : ''),
              onClick: () => inbox.setStatus(tab),
            },
            t[tab],
          ),
        ),
      ),
    ),
    el(
      'div',
      { class: 'hb-ap__body' },
      el('div', { class: 'hb-ap__list' }, list),
      el(
        'div',
        { class: 'hb-ap__detail' },
        s.activeId ? renderCard(el, s, inbox, t, { ...opts, onBack: () => inbox.close() }) : el('p', { class: 'hb-ap-empty hb-ap-empty--detail' }, ''),
      ),
    ),
  );
}
