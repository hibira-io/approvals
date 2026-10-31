// Vue 3 components for the approvals inbox. Bring your own pusher-js
// instance through createApprovalsClient(); import
// '@hibira-io/approvals/styles.css' for the default look.

import { defineComponent, h, onBeforeUnmount, shallowRef, watch } from 'vue';
import { createInbox } from './inbox.js';
import { labelsFor } from './locales.js';
import { renderCard, renderInbox } from './view.js';

export { createApprovalsClient } from './client.js';

function el(tag, props, ...children) {
  const out = {};
  for (const [k, v] of Object.entries(props ?? {})) if (v !== undefined) out[k] = v;
  const kids = children.flat().filter((c) => c != null && c !== false);
  if (tag === 'textarea' || tag === 'img' || tag === 'path') return h(tag, out);
  return h(tag, out, kids);
}

/**
 * The live inbox state for `client` as refs: { state, inbox }. Pass `id`
 * (a value or a getter) to follow a single request.
 */
export function useApprovalInbox(client, options = {}) {
  const inbox = shallowRef(null);
  const state = shallowRef(null);
  let stop = () => {};
  const start = (id) => {
    stop();
    const created = createInbox(client, { id, status: options.status });
    inbox.value = created;
    state.value = created.getState();
    const unsubscribe = created.subscribe((s) => (state.value = s));
    stop = () => {
      unsubscribe();
      created.destroy();
    };
  };
  const idOf = () => (typeof options.id === 'function' ? options.id() : options.id);
  watch(idOf, (id) => start(id), { immediate: true });
  onBeforeUnmount(() => stop());
  return { inbox, state };
}

const common = {
  client: { type: Object, required: true },
  locale: { type: String, default: undefined },
  labels: { type: Object, default: undefined },
  me: { type: [String, Number], default: undefined },
};

/** List of requests with the open one beside it. */
export const ApprovalInbox = defineComponent({
  name: 'ApprovalInbox',
  props: { ...common, status: { type: String, default: 'pending' } },
  setup(props) {
    const { inbox, state } = useApprovalInbox(props.client, { status: props.status });
    return () =>
      inbox.value && state.value
        ? renderInbox(el, state.value, inbox.value, labelsFor(props.locale, props.labels), { locale: props.locale, me: props.me })
        : null;
  },
});

/** One request, for example inline in a chat next to the agent's message. */
export const ApprovalCard = defineComponent({
  name: 'ApprovalCard',
  props: { ...common, id: { type: String, required: true } },
  setup(props) {
    const { inbox, state } = useApprovalInbox(props.client, { id: () => props.id });
    return () =>
      inbox.value && state.value
        ? renderCard(el, state.value, inbox.value, labelsFor(props.locale, props.labels), { locale: props.locale, me: props.me })
        : null;
  },
});
