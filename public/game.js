'use strict';

const socket = io();
const BOARD = 10;
// Порядок кораблей для расстановки (по палубам, от большого к малому).
const SHIP_QUEUE = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const FLEET_LABELS = [
  { size: 4, need: 1, name: '4-палубный' },
  { size: 3, need: 2, name: '3-палубные' },
  { size: 2, need: 3, name: '2-палубные' },
  { size: 1, need: 4, name: '1-палубные' },
];

// ---- Переключение экранов ----
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---- Состояние расстановки ----
let placed = [];        // [{ size, cells:[{x,y}] }]
let nextIndex = 0;      // индекс следующего корабля в SHIP_QUEUE
let orientation = 'h';  // 'h' | 'v'

function occupiedSet(ships) {
  const s = new Set();
  for (const ship of ships) for (const c of ship.cells) s.add(`${c.x},${c.y}`);
  return s;
}

// Клетки корабля размера size с началом в (x,y) при данной ориентации.
function shipCells(x, y, size, orient) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    cells.push(orient === 'h' ? { x: x + i, y } : { x, y: y + i });
  }
  return cells;
}

// Можно ли поставить корабль: в пределах поля и не касается уже стоящих.
function canPlace(cells, ships) {
  const occ = occupiedSet(ships);
  for (const c of cells) {
    if (c.x < 0 || c.x >= BOARD || c.y < 0 || c.y >= BOARD) return false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (occ.has(`${c.x + dx},${c.y + dy}`)) return false;
      }
    }
  }
  return true;
}

// ---- Отрисовка поля расстановки ----
const boardPlace = document.getElementById('board-place');

function buildBoard(el, onTap) {
  el.innerHTML = '';
  for (let y = 0; y < BOARD; y++) {
    for (let x = 0; x < BOARD; x++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.x = x;
      cell.dataset.y = y;
      if (onTap) cell.addEventListener('click', () => onTap(x, y, cell));
      el.appendChild(cell);
    }
  }
}

function cellAt(el, x, y) {
  return el.querySelector(`.cell[data-x="${x}"][data-y="${y}"]`);
}

function renderPlacement() {
  boardPlace.querySelectorAll('.cell').forEach((c) => (c.className = 'cell'));
  for (const ship of placed) {
    for (const c of ship.cells) cellAt(boardPlace, c.x, c.y).classList.add('ship-place');
  }
  // легенда состава
  const counts = {};
  for (const s of placed) counts[s.size] = (counts[s.size] || 0) + 1;
  const legend = document.getElementById('fleet-legend');
  legend.innerHTML = '';
  for (const f of FLEET_LABELS) {
    const have = counts[f.size] || 0;
    const el = document.createElement('span');
    el.className = 'fl' + (have === f.need ? ' done' : '');
    el.textContent = `${f.name}: ${have}/${f.need}`;
    legend.appendChild(el);
  }
  // статус
  const status = document.getElementById('place-status');
  if (nextIndex >= SHIP_QUEUE.length) {
    status.textContent = 'Флот готов! Нажмите «Готов к бою»';
  } else {
    const size = SHIP_QUEUE[nextIndex];
    const dir = orientation === 'h' ? 'горизонтально ➡️' : 'вертикально ⬇️';
    status.textContent = `Ставим ${size}-палубный (${dir}). Нажмите на поле.`;
  }
  document.getElementById('btn-ready').disabled = nextIndex < SHIP_QUEUE.length;
  document.getElementById('place-error').textContent = '';
}

function onPlaceTap(x, y) {
  // тап по уже стоящему кораблю — убрать его
  const idx = placed.findIndex((s) => s.cells.some((c) => c.x === x && c.y === y));
  if (idx !== -1) {
    placed.splice(idx, 1);
    // пересчитать nextIndex: снять один корабль из очереди
    nextIndex = placed.length;
    renderPlacement();
    return;
  }
  if (nextIndex >= SHIP_QUEUE.length) return;
  const size = SHIP_QUEUE[nextIndex];
  const cells = shipCells(x, y, size, orientation);
  if (!canPlace(cells, placed)) {
    document.getElementById('place-error').textContent = 'Сюда нельзя — выходит за поле или касается корабля';
    return;
  }
  placed.push({ size, cells });
  nextIndex++;
  renderPlacement();
}

// Случайная расстановка всего флота.
function randomPlacement() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ships = [];
    let ok = true;
    for (const size of SHIP_QUEUE) {
      let done = false;
      for (let t = 0; t < 100; t++) {
        const orient = Math.random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(Math.random() * BOARD);
        const y = Math.floor(Math.random() * BOARD);
        const cells = shipCells(x, y, size, orient);
        if (canPlace(cells, ships)) { ships.push({ size, cells }); done = true; break; }
      }
      if (!done) { ok = false; break; }
    }
    if (ok) { placed = ships; nextIndex = SHIP_QUEUE.length; renderPlacement(); return; }
  }
}

// ---- Кнопки расстановки ----
document.getElementById('btn-random').addEventListener('click', randomPlacement);
document.getElementById('btn-clear').addEventListener('click', () => {
  placed = []; nextIndex = 0; renderPlacement();
});
// Поворот: клик по статусу меняет ориентацию следующего корабля.
document.getElementById('place-status').addEventListener('click', () => {
  orientation = orientation === 'h' ? 'v' : 'h';
  renderPlacement();
});
document.getElementById('btn-ready').addEventListener('click', () => {
  if (nextIndex < SHIP_QUEUE.length) return;
  socket.emit('place_ships', { ships: placed });
  document.getElementById('btn-ready').disabled = true;
  document.getElementById('place-status').textContent = 'Ждём соперника…';
});

// ---- Меню ----
document.getElementById('btn-create').addEventListener('click', () => socket.emit('create_room'));
document.getElementById('btn-join').addEventListener('click', () => {
  const code = document.getElementById('input-code').value.trim();
  if (code.length !== 4) {
    document.getElementById('menu-error').textContent = 'Введите 4-значный код';
    return;
  }
  socket.emit('join_room', { code });
});

// ---- Бой ----
const boardEnemy = document.getElementById('board-enemy');
const boardOwn = document.getElementById('board-own');
let myTurn = false;

function startBattle() {
  buildBoard(boardEnemy, onFireTap);
  buildBoard(boardOwn, null);
  // показать свой флот
  for (const ship of placed) {
    for (const c of ship.cells) cellAt(boardOwn, c.x, c.y).classList.add('ship');
  }
  show('screen-battle');
}

function setTurn(yourTurn) {
  myTurn = yourTurn;
  const banner = document.getElementById('turn-banner');
  banner.className = 'turn-banner ' + (yourTurn ? 'you' : 'enemy');
  banner.textContent = yourTurn ? '🎯 Ваш ход — стреляйте!' : '⏳ Ход соперника…';
  boardEnemy.classList.toggle('locked', !yourTurn);
}

function onFireTap(x, y, cell) {
  if (!myTurn) return;
  if (cell.classList.contains('miss') || cell.classList.contains('hit') || cell.classList.contains('sunk')) return;
  myTurn = false;                    // блок до ответа сервера
  boardEnemy.classList.add('locked');
  socket.emit('fire', { x, y });
}

// пометить клетки вокруг потопленного корабля как промах (визуально)
function markSunkSurround(board, shipCells) {
  const occ = new Set(shipCells.map((c) => `${c.x},${c.y}`));
  for (const c of shipCells) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || nx >= BOARD || ny < 0 || ny >= BOARD) continue;
        if (occ.has(`${nx},${ny}`)) continue;
        const cell = cellAt(board, nx, ny);
        if (!cell.classList.contains('hit') && !cell.classList.contains('sunk')) {
          cell.classList.add('miss');
        }
      }
    }
  }
}

// ---- Socket-события ----
socket.on('room_created', ({ code }) => {
  document.getElementById('room-code').textContent = code;
  show('screen-wait');
});

socket.on('joined', () => { /* переход по start_placing */ });

socket.on('start_placing', () => {
  placed = []; nextIndex = 0; orientation = 'h';
  buildBoard(boardPlace, onPlaceTap);
  renderPlacement();
  show('screen-place');
});

socket.on('placed_ok', () => {});

socket.on('start_battle', ({ yourTurn }) => {
  startBattle();
  setTurn(yourTurn);
});

socket.on('fire_result', ({ x, y, result, ship, yourTurn }) => {
  const cell = cellAt(boardEnemy, x, y);
  if (result === 'miss') cell.classList.add('miss');
  else if (result === 'hit') cell.classList.add('hit');
  else if (result === 'sunk') {
    if (ship) {
      for (const c of ship) cellAt(boardEnemy, c.x, c.y).classList.add('sunk');
      markSunkSurround(boardEnemy, ship);
    } else cell.classList.add('sunk');
  }
  setTurn(yourTurn);
});

socket.on('incoming_fire', ({ x, y, result, ship, yourTurn }) => {
  const cell = cellAt(boardOwn, x, y);
  if (result === 'miss') cell.classList.add('miss');
  else if (result === 'hit') cell.classList.add('hit');
  else if (result === 'sunk') {
    if (ship) {
      for (const c of ship) cellAt(boardOwn, c.x, c.y).classList.add('sunk');
      markSunkSurround(boardOwn, ship);
    } else cell.classList.add('sunk');
  }
  setTurn(yourTurn);
});

socket.on('game_over', ({ win }) => {
  document.getElementById('over-title').textContent = win ? '🏆 Победа!' : '💥 Поражение';
  document.getElementById('over-sub').textContent = win
    ? 'Весь флот соперника потоплен!'
    : 'Ваш флот уничтожен.';
  document.getElementById('over-hint').textContent = '';
  document.getElementById('btn-rematch').disabled = false;
  show('screen-over');
});

document.getElementById('btn-rematch').addEventListener('click', () => {
  socket.emit('rematch');
  document.getElementById('btn-rematch').disabled = true;
  document.getElementById('over-hint').textContent = 'Ждём соперника…';
});

socket.on('waiting_rematch', () => {
  document.getElementById('over-hint').textContent = 'Ждём соперника…';
});

socket.on('opponent_left', () => {
  alert('Соперник вышел из игры. Возврат в меню.');
  location.reload();
});

socket.on('error_msg', ({ msg }) => {
  // ошибки меню и расстановки
  const menuActive = document.getElementById('screen-menu').classList.contains('active');
  const target = menuActive ? 'menu-error' : 'place-error';
  const el = document.getElementById(target);
  if (el) el.textContent = msg;
});
