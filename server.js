'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const rooms = new Map();
const streams = new Map();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('请求数据过大'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('JSON格式无效')); }
    });
    req.on('error', reject);
  });
}

function createCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = [...crypto.randomBytes(6)].map(byte => alphabet[byte % alphabet.length]).join('').slice(0, 6);
  } while (rooms.has(code));
  return code;
}

function teamFor(room, clientId) {
  if (room.players.home === clientId) return 'home';
  if (room.players.away === clientId) return 'away';
  return '';
}

function publicRoom(room) {
  return {
    code: room.code, pool: room.pool, draftOrder: room.draftOrder, rosters: room.rosters, pickIndex: room.pickIndex,
    players: { home: Boolean(room.players.home), away: Boolean(room.players.away) }
  };
}

function emitTo(clientId, payload) {
  const clientStreams = streams.get(clientId);
  if (!clientStreams) return;
  const packet = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...clientStreams]) {
    try { res.write(packet); } catch { clientStreams.delete(res); }
  }
}

function broadcast(room, payload) {
  if (room.players.home) emitTo(room.players.home, payload);
  if (room.players.away) emitTo(room.players.away, payload);
}

function broadcastRoom(room) {
  for (const team of ['home', 'away']) {
    if (room.players[team]) emitTo(room.players[team], { type: 'room', team, room: publicRoom(room) });
  }
}

function addMatchEvent(match, text, category = '比赛动态', key = false, breakdown = '') {
  match.events.unshift({ minute: `${Math.floor(match.minute)}’`, text, category, key, breakdown });
  match.events = match.events.slice(0, 80);
}

function freshMatch() {
  return {
    minute: 0, phase: '常规时间', home: 0, away: 0, running: false, speed: 1,
    events: [], energy: 100, morale: 72, subs: 0, tick: 0, finished: false,
    penalty: '', halfTimeShown: false
  };
}

function broadcastMatch(room) {
  if (room.match) broadcast(room, { type: 'matchState', snapshot: { ...room.match, events: room.match.events, deployments: room.deployments, deploymentVersion: room.deploymentVersion } });
}

function finishMatch(room) {
  room.match.running = false;
  room.match.finished = true;
  addMatchEvent(room.match, `全场结束，最终比分 ${room.match.home}—${room.match.away}。`, '比赛结束', true, '房间服务器已锁定赛果。');
}

function runPenaltyShootout(room) {
  const homePens = 3 + Math.floor(Math.random() * 3);
  let awayPens = 3 + Math.floor(Math.random() * 3);
  if (homePens === awayPens) awayPens = Math.min(5, awayPens + 1);
  room.match.penalty = `点球 ${homePens}—${awayPens}`;
  if (homePens > awayPens) room.match.home += 1; else room.match.away += 1;
  addMatchEvent(room.match, `点球大战结束：${homePens}—${awayPens}，胜负终于揭晓！`, '点球大战', true, '压力、门将判断与少量可控随机共同决定结果。');
  finishMatch(room);
}

function simulateMatch(room) {
  const match = room.match;
  if (!match || !match.running || match.finished) return;
  match.tick += 1;
  match.minute += 0.1875 * match.speed;
  match.energy = Math.max(24, match.energy - 0.078 * match.speed);

  if (!match.halfTimeShown && match.minute >= 45) {
    match.halfTimeShown = true;
    addMatchEvent(match, `半场结束前双方仍在高强度对抗，当前比分 ${match.home}—${match.away}。`, '半场节点', true);
  }

  const eventEvery = match.speed === 16 ? 2 : Math.max(2, Math.round(8 / match.speed));
  if (match.tick % eventEvery === 0) {
    const homeAttack = Math.random() < 0.5;
    const side = homeAttack ? '主队' : '客队';
    const opponent = homeAttack ? '客队' : '主队';
    const roll = Math.random();
    if (roll < 0.17) {
      addMatchEvent(match, `${side}连续一脚传递拉开防线，中场突然送出穿透直塞，前锋已经启动！`, '组织推进');
    } else if (roll < 0.32) {
      const lateBoost = match.minute >= 75 ? 0.05 : 0;
      if (Math.random() < 0.14 + lateBoost) {
        if (homeAttack) match.home += 1; else match.away += 1;
        addMatchEvent(match, `${side}进球！${opponent}边后卫前插后留下空当，快速反击形成单刀并冷静破门。`, '进球', true, '空间利用 36% · 位置适应 25% · 球员能力 27% · 可控随机 12%');
      } else addMatchEvent(match, `${side}在禁区前沿获得半步空间起脚，皮球擦着立柱偏出！`, '威胁射门');
    } else if (roll < 0.47) {
      addMatchEvent(match, `${side}送出穿透直塞后近距离推射，门将倒地用腿完成关键扑救！`, '神勇扑救', true, '门将反应与站位化解了高质量机会。');
    } else if (roll < 0.63) {
      addMatchEvent(match, `${side}丢球后立即反抢，双方在中场连续对脚，比赛节奏明显加快。`, '激烈对抗');
    } else if (roll < 0.78) {
      addMatchEvent(match, `${side}赢得前场定位球，皮球旋向后点，${opponent}中卫抢先头球解围。`, '定位球');
    } else if (roll < 0.91) {
      addMatchEvent(match, `${opponent}边路压得太深，${side}断球后形成三打三，最后横传被回追球员破坏。`, '快速反击');
    } else addMatchEvent(match, `${side}全面压上，禁区内已堆积多名进攻球员，比赛进入窒息般的争夺！`, '战术博弈', true);
  }

  if (match.phase === '常规时间' && match.minute >= 90) {
    match.minute = 90;
    if (match.home === match.away) {
      match.phase = '加时赛';
      addMatchEvent(match, '常规时间战平，比赛进入加时赛。', '加时赛', true);
    } else finishMatch(room);
  } else if (match.phase === '加时赛' && match.minute >= 120) {
    match.minute = 120;
    if (match.home === match.away) runPenaltyShootout(room); else finishMatch(room);
  }
  broadcastMatch(room);
}

function handleCommand(room, team, command) {
  if (!room.match || !command || typeof command.type !== 'string') return;
  if (command.type === 'toggle') room.match.running = !room.match.running;
  if (command.type === 'speed') room.match.speed = [1, 4, 16].includes(Number(command.value)) ? Number(command.value) : 1;
  if (command.type === 'tactic') {
    room.deployments[team].tactics[command.key] = String(command.value || '');
    addMatchEvent(room.match, `${team === 'home' ? '主队' : '客队'}临场调整战术倾向，收益与风险立即进入结算。`, '战术调整', true);
  }
  if (command.type === 'formation') {
    room.deployments[team].formation = String(command.value || '433');
    addMatchEvent(room.match, `${team === 'home' ? '主队' : '客队'}在场上完成即时变阵。`, '即时变阵', true, '阵型宽度、纵深与局部人数关系已重新计算。');
  }
  if (command.type === 'lineup' && command.deployment) { room.deployments[team] = command.deployment; room.deploymentVersion += 1; }
  if (command.type === 'shout') {
    const success = Math.random() < 0.58;
    room.match.morale = Math.max(40, Math.min(95, room.match.morale + (success ? 7 : -4)));
    addMatchEvent(room.match, success ? '场边喊话激活了球队，逼抢和跑动更加果断。' : '喊话效果不佳，部分球员的信心出现波动。', '场边喊话');
  }
  broadcastMatch(room);
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/create' && req.method === 'POST') {
    const body = await readJson(req);
    if (!Array.isArray(body.pool) || body.pool.length !== 80 || !Array.isArray(body.draftOrder) || body.draftOrder.length !== 32) return sendJson(res, 400, { error: '球员池或选秀顺序无效' });
    const code = createCode();
    const clientId = crypto.randomUUID();
    const room = {
      code, pool: body.pool, draftOrder: body.draftOrder, rosters: { home: [], away: [] }, pickIndex: 0,
      players: { home: clientId, away: '' }, deployments: {}, deploymentVersion: 0, match: null, createdAt: Date.now(), updatedAt: Date.now()
    };
    rooms.set(code, room);
    return sendJson(res, 200, { team: 'home', clientId, room: publicRoom(room) });
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    const body = await readJson(req);
    const code = String(body.code || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return sendJson(res, 404, { error: '房间不存在或已失效' });
    if (room.players.away) return sendJson(res, 409, { error: '房间已有两名玩家' });
    const clientId = crypto.randomUUID();
    room.players.away = clientId; room.updatedAt = Date.now();
    sendJson(res, 200, { team: 'away', clientId, room: publicRoom(room) });
    broadcastRoom(room);
    return;
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    const body = await readJson(req);
    const code = String(body.code || '').toUpperCase();
    const room = rooms.get(code);
    const team = room ? teamFor(room, String(body.clientId || '')) : '';
    if (!room || !team) return sendJson(res, 403, { error: '无权操作此房间' });
    room.updatedAt = Date.now();

    if (body.action === 'pick') {
      const expected = room.draftOrder[room.pickIndex];
      const player = room.pool.find(item => item.id === body.playerId);
      const alreadyPicked = [...room.rosters.home, ...room.rosters.away].some(item => item.id === body.playerId);
      if (expected !== team || !player || alreadyPicked) return sendJson(res, 409, { error: '当前无法选择该球员' });
      room.rosters[team].push(player); room.pickIndex += 1; broadcastRoom(room);
    }

    if (body.action === 'ready') {
      const deployment = body.deployment;
      if (!deployment || !Array.isArray(deployment.starting) || deployment.starting.length !== 11) return sendJson(res, 400, { error: '首发阵容必须为11人' });
      room.deployments[team] = deployment;
      if (room.deployments.home && room.deployments.away) {
        room.match = freshMatch();
        room.deploymentVersion += 1;
        addMatchEvent(room.match, '双方部署完成，服务器已锁定首发，等待开球。', '开场');
        broadcast(room, { type: 'matchReady', deployments: room.deployments });
        broadcastMatch(room);
      }
    }

    if (body.action === 'command') handleCommand(room, team, body.command);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/heartbeat' && req.method === 'POST') {
    const body = await readJson(req);
    const room = rooms.get(String(body.code || '').toUpperCase());
    if (room && teamFor(room, String(body.clientId || ''))) room.updatedAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

function openEventStream(req, res, url) {
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  const clientId = String(url.searchParams.get('clientId') || '');
  const room = rooms.get(code);
  const team = room ? teamFor(room, clientId) : '';
  if (!room || !team) return sendJson(res, 403, { error: '无权订阅此房间' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'room', team, room: publicRoom(room) })}\n\n`);
  if (!streams.has(clientId)) streams.set(clientId, new Set());
  streams.get(clientId).add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    const clientStreams = streams.get(clientId);
    if (clientStreams) { clientStreams.delete(res); if (!clientStreams.size) streams.delete(clientId); }
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true, rooms: rooms.size, transport: 'sse' });
    if (url.pathname === '/events' && req.method === 'GET') return openEventStream(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
    if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, 403, { error: 'forbidden' });
    fs.readFile(filePath, (error, data) => {
      if (error) return sendJson(res, error.code === 'ENOENT' ? 404 : 500, { error: 'not_found' });
      res.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'Cache-Control': path.extname(filePath) === '.html' ? 'no-store' : 'public, max-age=300'
      });
      res.end(data);
    });
  } catch (error) {
    if (!res.headersSent) sendJson(res, 400, { error: error.message || '请求失败' });
  }
});

setInterval(() => { for (const room of rooms.values()) simulateMatch(room); }, 1000);
setInterval(() => {
  const expiry = Date.now() - 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) if (room.updatedAt < expiry) rooms.delete(code);
}, 10 * 60 * 1000);

server.listen(PORT, HOST, () => console.log(`足球冠军教练运行于 http://${HOST}:${PORT}`));
