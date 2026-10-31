// React components for the approvals inbox. Bring your own pusher-js
// instance through createApprovalsClient(); import
// '@hibira-io/approvals/styles.css' for the default look.

import { createElement, useEffect, useState } from 'react';
import { createInbox } from './inbox.js';
import { labelsFor } from './locales.js';
import { renderCard, renderInbox } from './view.js';

export { createApprovalsClient } from './client.js';

const RENAME = {
  class: 'className',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  spellcheck: 'spellCheck',
};

function el(tag, props, ...children) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined) continue;
    if (k === 'onInput') out.onChange = v;
    else out[RENAME[k] ?? k] = v;
  }
  return createElement(tag, out, ...children.flat().filter((c) => c != null && c !== false));
}

/**
 * The live inbox state for `client`: { state, inbox } where inbox has
 * open(id), decide(callId, decision), send()... Pass `id` to follow a single
 * request.
 */
export function useApprovalInbox(client, options = {}) {
  const [inbox, setInbox] = useState(null);
  const [state, setState] = useState(null);
  const { id, status } = options;
  useEffect(() => {
    const created = createInbox(client, { id, status });
    setInbox(created);
    setState(created.getState());
    const stop = created.subscribe(setState);
    return () => {
      stop();
      created.destroy();
    };
  }, [client, id]);
  return { inbox, state };
}

/** List of requests with the open one beside it. */
export function ApprovalInbox({ client, status, locale, labels, me, className }) {
  const { inbox, state } = useApprovalInbox(client, { status });
  if (!inbox || !state) return null;
  const t = labelsFor(locale, labels);
  const view = renderInbox(el, state, inbox, t, { locale, me });
  return className ? createElement('div', { className }, view) : view;
}

/** One request, for example inline in a chat next to the agent's message. */
export function ApprovalCard({ client, id, locale, labels, me, className }) {
  const { inbox, state } = useApprovalInbox(client, { id });
  if (!inbox || !state) return null;
  const t = labelsFor(locale, labels);
  const view = renderCard(el, state, inbox, t, { locale, me });
  return className ? createElement('div', { className }, view) : view;
}
