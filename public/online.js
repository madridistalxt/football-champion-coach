(() => {
  let callbacks = {};
  let roomCode = '';
  let clientId = '';
  let eventSource = null;
  let heartbeat = null;

  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '服务器操作失败');
    return result;
  }

  function notifyError(message) {
    if (callbacks.onError) callbacks.onError(message);
  }

  function connectEvents(code, id) {
    if (eventSource) eventSource.close();
    roomCode = code;
    clientId = id;
    eventSource = new EventSource(`/events?code=${encodeURIComponent(code)}&clientId=${encodeURIComponent(id)}`);
    eventSource.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'room' && callbacks.onRoom) callbacks.onRoom(message);
      if (message.type === 'matchReady' && callbacks.onMatchReady) callbacks.onMatchReady(message);
      if (message.type === 'matchState' && callbacks.onMatchState) callbacks.onMatchState(message.snapshot);
    };
    eventSource.onerror = () => {
      if (eventSource && eventSource.readyState === EventSource.CLOSED) notifyError('实时连接已断开，请刷新页面重试。');
    };
    clearInterval(heartbeat);
    heartbeat = setInterval(() => post('/api/heartbeat', { code: roomCode, clientId }).catch(() => {}), 4 * 60 * 1000);
  }

  function background(action, payload = {}) {
    post('/api/action', { action, code: roomCode, clientId, ...payload }).catch(error => notifyError(error.message));
  }

  window.FCOnline = {
    init(handlers) { callbacks = handlers || {}; },
    async createRoom({ pool, draftOrder }) {
      const result = await post('/api/create', { pool, draftOrder });
      connectEvents(result.room.code, result.clientId);
      return { team: result.team, room: result.room };
    },
    async joinRoom(code) {
      const result = await post('/api/join', { code });
      connectEvents(result.room.code, result.clientId);
      return { team: result.team, room: result.room };
    },
    pick(code, playerId) { background('pick', { playerId }); },
    ready(code, deployment) { background('ready', { deployment }); },
    command(code, command) { background('command', { command }); }
  };
})();
