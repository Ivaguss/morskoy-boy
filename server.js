'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Не кэшировать — чтобы телефоны всегда получали свежую версию игры
// (иначе браузер может показать старую страницу из кэша).
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BOARD = 10;
// Классический русский флот: сколько кораблей каждого размера (по палубам).
const FLEET = { 4: 1, 3: 2, 2: 3, 1: 4 };
const TOTAL_CELLS = Object.entries(FLEET)
  .reduce((sum, [size, count]) => sum + Number(size) * count, 0); // = 20

/**
 * rooms: code -> {
 *   code, state: 'waiting'|'placing'|'playing'|'finished',
 *   players: { [socketId]: { ships, hits:Set, sunkCount, ready } },
 *   order: [socketId, socketId],   // индекс 0 и 1
 *   turn: socketId | null
 * }
 */
const rooms = new Map();
const socketRoom = new Map(); // socketId -> code

function genCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

// ---- Валидация расстановки ----

function cellKey(x, y) {
  return `${x},${y}`;
}

/**
 * Проверяет расстановку. ships — массив { size, cells:[{x,y}] }.
 * Возвращает { ok:true } или { ok:false, msg }.
 */
function validateShips(ships) {
  if (!Array.isArray(ships)) return { ok: false, msg: 'Некорректные данные' };

  const counts = {};
  const occupied = new Map(); // key -> true

  for (const ship of ships) {
    if (!ship || !Array.isArray(ship.cells) || ship.cells.length === 0) {
      return { ok: false, msg: 'Некорректный корабль' };
    }
    const cells = ship.cells;
    // все клетки в пределах поля и целочисленные
    for (const c of cells) {
      if (
        !Number.isInteger(c.x) || !Number.isInteger(c.y) ||
        c.x < 0 || c.x >= BOARD || c.y < 0 || c.y >= BOARD
      ) {
        return { ok: false, msg: 'Клетка вне поля' };
      }
    }
    // прямой и непрерывный (горизонталь или вертикаль)
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const sameRow = ys.every((y) => y === ys[0]);
    const sameCol = xs.every((x) => x === xs[0]);
    if (!sameRow && !sameCol) {
      return { ok: false, msg: 'Корабль должен быть прямым' };
    }
    const sorted = [...cells].sort((a, b) => (a.x - b.x) || (a.y - b.y));
    for (let i = 1; i < sorted.length; i++) {
      const dx = sorted[i].x - sorted[i - 1].x;
      const dy = sorted[i].y - sorted[i - 1].y;
      if (dx + dy !== 1) {
        return { ok: false, msg: 'Клетки корабля должны идти подряд' };
      }
    }

    const size = cells.length;
    counts[size] = (counts[size] || 0) + 1;

    // проверка пересечений и касаний (включая диагонали)
    for (const c of cells) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const nk = cellKey(c.x + dx, c.y + dy);
          if (occupied.has(nk) && !cells.some((cc) => cellKey(cc.x, cc.y) === nk)) {
            return { ok: false, msg: 'Корабли не должны касаться друг друга' };
          }
        }
      }
    }
    for (const c of cells) occupied.set(cellKey(c.x, c.y), true);
  }

  // проверка состава флота
  for (const size of Object.keys(FLEET)) {
    if ((counts[size] || 0) !== FLEET[size]) {
      return { ok: false, msg: 'Неверный состав флота' };
    }
  }
  // не должно быть кораблей неожиданных размеров
  for (const size of Object.keys(counts)) {
    if (!FLEET[size]) return { ok: false, msg: 'Неверный состав флота' };
  }

  return { ok: true };
}

// ---- Логика выстрела ----

/**
 * Обрабатывает выстрел стрелявшего по обороняющемуся.
 * Возвращает { result: 'miss'|'hit'|'sunk', already?:true, win?:true }.
 */
function applyShot(defender, x, y) {
  const key = cellKey(x, y);
  if (defender.hits.has(key)) return { already: true };
  defender.hits.add(key);

  // ищем корабль в этой клетке
  const ship = defender.ships.find((s) =>
    s.cells.some((c) => c.x === x && c.y === y)
  );
  if (!ship) return { result: 'miss' };

  const sunk = ship.cells.every((c) => defender.hits.has(cellKey(c.x, c.y)));
  if (sunk) {
    defender.sunkCount += 1;
    const win = defender.hits.size >= TOTAL_CELLS &&
      defender.ships.every((s) =>
        s.cells.every((c) => defender.hits.has(cellKey(c.x, c.y)))
      );
    return { result: 'sunk', ship: ship.cells, win };
  }
  return { result: 'hit' };
}

function opponentId(room, id) {
  return room.order.find((pid) => pid !== id) || null;
}

function closeRoom(code, exceptId) {
  const room = rooms.get(code);
  if (!room) return;
  for (const pid of room.order) {
    if (pid !== exceptId) io.to(pid).emit('opponent_left');
    socketRoom.delete(pid);
  }
  rooms.delete(code);
}

// ---- Socket-обработчики ----

io.on('connection', (socket) => {
  socket.on('create_room', () => {
    if (socketRoom.has(socket.id)) return;
    const code = genCode();
    const room = {
      code,
      state: 'waiting',
      players: {
        [socket.id]: { ships: null, hits: new Set(), sunkCount: 0, ready: false },
      },
      order: [socket.id],
      turn: null,
    };
    rooms.set(code, room);
    socketRoom.set(socket.id, code);
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code } = {}) => {
    if (socketRoom.has(socket.id)) return;
    code = String(code || '').trim();
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', { msg: 'Комната не найдена' });
    if (room.order.length >= 2) {
      return socket.emit('error_msg', { msg: 'Комната уже заполнена' });
    }
    room.players[socket.id] = { ships: null, hits: new Set(), sunkCount: 0, ready: false };
    room.order.push(socket.id);
    socketRoom.set(socket.id, code);
    room.state = 'placing';

    socket.emit('joined', { code });
    // обоим — переход к расстановке
    for (const pid of room.order) io.to(pid).emit('start_placing');
  });

  socket.on('place_ships', ({ ships } = {}) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room || room.state !== 'placing') return;
    const player = room.players[socket.id];
    if (!player || player.ready) return;

    const check = validateShips(ships);
    if (!check.ok) return socket.emit('error_msg', { msg: check.msg });

    player.ships = ships;
    player.ready = true;
    socket.emit('placed_ok');

    const bothReady = room.order.length === 2 &&
      room.order.every((pid) => room.players[pid].ready);
    if (bothReady) {
      room.state = 'playing';
      room.turn = room.order[Math.floor(Math.random() * 2)];
      for (const pid of room.order) {
        io.to(pid).emit('start_battle', { yourTurn: pid === room.turn });
      }
    }
  });

  socket.on('fire', ({ x, y } = {}) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room || room.state !== 'playing') return;
    if (room.turn !== socket.id) return; // не твой ход
    if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || x >= BOARD || y < 0 || y >= BOARD) return;

    const defenderId = opponentId(room, socket.id);
    const defender = room.players[defenderId];
    if (!defender) return;

    const res = applyShot(defender, x, y);
    if (res.already) return; // повтор по той же клетке — игнор

    const hitAgain = res.result === 'hit' || res.result === 'sunk';
    if (!hitAgain) room.turn = defenderId;

    // стрелявшему — результат его выстрела
    socket.emit('fire_result', {
      x, y,
      result: res.result,
      ship: res.ship || null,
      yourTurn: room.turn === socket.id,
    });
    // обороняющемуся — входящий выстрел
    io.to(defenderId).emit('incoming_fire', {
      x, y,
      result: res.result,
      ship: res.ship || null,
      yourTurn: room.turn === defenderId,
    });

    if (res.win) {
      room.state = 'finished';
      socket.emit('game_over', { win: true });
      io.to(defenderId).emit('game_over', { win: false });
    }
  });

  socket.on('rematch', () => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;
    player.ships = null;
    player.hits = new Set();
    player.sunkCount = 0;
    player.ready = false;
    player.wantsRematch = true;

    const bothWant = room.order.length === 2 &&
      room.order.every((pid) => room.players[pid].wantsRematch);
    if (bothWant) {
      for (const pid of room.order) room.players[pid].wantsRematch = false;
      room.state = 'placing';
      room.turn = null;
      for (const pid of room.order) io.to(pid).emit('start_placing');
    } else {
      socket.emit('waiting_rematch');
    }
  });

  socket.on('disconnect', () => {
    const code = socketRoom.get(socket.id);
    if (code) closeRoom(code, socket.id);
    socketRoom.delete(socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Морской бой запущен: http://localhost:${PORT}`);
});
