export function fakePusher() {
  const events = [];
  return {
    events,
    trigger(channel, event, data) {
      events.push({ channel, event, data });
    },
    authorizeChannel(socketId, channel, presence) {
      return { auth: `key:sig-${socketId}-${channel}`, ...(presence ? { channel_data: JSON.stringify(presence) } : {}) };
    },
  };
}
