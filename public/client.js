console.log('Tic Tac Toe client (multiplayer) loaded');

const boardEl = document.getElementById('board');
const statusEl = document.getElementById('status');
const newGameBtn = document.getElementById('new-game');
const playerInfoEl = document.getElementById('player-info');
const shareLinkEl = document.getElementById('share-link');

let socket = null;
let currentGameId = null;
let board = Array(9).fill(null);
let currentPlayer = 'X';
let gameActive = false;
let mySymbol = null; // 'X' or 'O'
let playersInfo = { X: false, O: false };

// ---------- UI helpers ----------
function updateStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function renderBoard() {
  const cells = document.querySelectorAll('.cell');
  cells.forEach(cell => {
    const index = parseInt(cell.getAttribute('data-index'), 10);
    cell.textContent = board[index] || '';
  });
}

function applyGameFromServer(game) {
  currentGameId = game.id;
  board = game.board;
  currentPlayer = game.currentPlayer;
  gameActive = game.active;

  renderBoard();

  if (!game.active) {
    if (game.winner === 'draw') {
      updateStatus("It's a draw! 🤝");
    } else if (game.winner === 'X' || game.winner === 'O') {
      updateStatus(`Player ${game.winner} wins! 🎉`);
    } else {
      updateStatus('Game finished.');
    }
  } else {
    updateStatus(`Player ${currentPlayer}'s turn`);
  }

  updateShareLink();
}

function updatePlayerInfo() {
  if (!playerInfoEl) return;

  if (!mySymbol) {
    playerInfoEl.textContent = 'Connecting to game...';
    return;
  }

  const xStatus = playersInfo.X ? 'connected' : 'waiting';
  const oStatus = playersInfo.O ? 'connected' : 'waiting';

  playerInfoEl.textContent =
    `You are Player ${mySymbol}. ` +
    `X: ${xStatus}, O: ${oStatus}.`;
}

function updateShareLink() {
  if (!shareLinkEl || !currentGameId) return;

  const url = new URL(window.location.href);
  url.searchParams.set('gameId', currentGameId);
  shareLinkEl.textContent =
    `Share this link with a friend to join as the other player:\n${url.toString()}`;
}

// ---------- API helpers (REST) ----------
async function startNewGameFromServer() {
  try {
    updateStatus('Creating new game...');
    const response = await fetch('/api/new-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      throw new Error('Failed to create new game');
    }

    const data = await response.json();
    applyGameFromServer(data.game);
    connectSocket(data.game.id);
  } catch (err) {
    console.error(err);
    updateStatus('Error creating new game (see console).');
  }
}

async function loadExistingGameFromServer(gameId) {
  try {
    updateStatus('Joining existing game...');
    const response = await fetch(`/api/game/${gameId}`);

    if (!response.ok) {
      throw new Error('Game not found');
    }

    const data = await response.json();
    applyGameFromServer(data.game);
    connectSocket(gameId);
  } catch (err) {
    console.error(err);
    updateStatus('Error loading game (maybe it does not exist).');
  }
}

// ---------- Socket.IO ----------
function connectSocket(gameId) {
  if (socket || typeof io === 'undefined') return;

  socket = io();

  socket.on('connect', () => {
    console.log('Socket connected:', socket.id);
    socket.emit('joinGame', { gameId });
  });

  socket.on('joinedGame', ({ gameId, symbol, game }) => {
    console.log('Joined game', gameId, 'as', symbol);
    mySymbol = symbol;
    applyGameFromServer(game);
    updateStatus(`You are Player ${symbol}. Player ${game.currentPlayer}'s turn`);
    updatePlayerInfo();
  });

  socket.on('playerInfo', ({ players }) => {
    playersInfo = players;
    updatePlayerInfo();
  });

  socket.on('gameState', ({ game }) => {
    applyGameFromServer(game);
    updatePlayerInfo();
  });

  socket.on('errorMessage', (msg) => {
    console.warn('Server:', msg);
    updateStatus(msg);
  });
}

// ---------- Event handlers ----------
async function handleCellClick(event) {
  const cell = event.target;
  if (!cell.classList.contains('cell')) return;
  if (!gameActive) return;
  if (!socket || !mySymbol) {
    updateStatus('Not connected to multiplayer yet.');
    return;
  }

  const index = parseInt(cell.getAttribute('data-index'), 10);
  if (board[index] !== null) {
    return; // already taken
  }

  // Server will validate whose turn it is
  socket.emit('makeMove', { index });
}

if (boardEl) {
  boardEl.addEventListener('click', handleCellClick);
}

if (newGameBtn) {
  newGameBtn.addEventListener('click', () => {
    // Start a completely new game (as creator)
    startNewGameFromServer();
  });
}

// ---------- Initial page load ----------
(function init() {
  const params = new URLSearchParams(window.location.search);
  const existingGameId = params.get('gameId');

  if (existingGameId) {
    loadExistingGameFromServer(existingGameId);
  } else {
    startNewGameFromServer();
  }
})();
