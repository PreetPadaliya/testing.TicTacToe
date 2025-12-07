// server.js
// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');


const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static('public'));

// ---------- In-memory game store ----------
const games = {};       // gameId -> game object
const gameHistory = []; // list of finished games (summary)
let nextGameId = 1;

// For multiplayer
const gamePlayers = {}; // gameId -> { X: socketId | null, O: socketId | null }
const socketToGame = {}; // socketId -> { gameId, symbol }

// Helper: create a new game
function createNewGame() {
  const id = String(nextGameId++);
  const now = new Date().toISOString();

  const game = {
    id,
    board: Array(9).fill(null),
    currentPlayer: 'X',
    active: true,
    winner: null, // 'X' | 'O' | 'draw' | null
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  };

  games[id] = game;
  return game;
}

// Helper: win/draw checks
const winningCombos = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function checkWin(board, player) {
  return winningCombos.some(([a, b, c]) => {
    return board[a] === player && board[b] === player && board[c] === player;
  });
}

function checkDraw(board) {
  return board.every(cell => cell !== null);
}

async function saveGameToDB(game) {
  const totalMoves = game.board.filter((cell) => cell !== null).length;
  const finalBoard = game.board.map((cell) => cell || '-').join('');

  // Convert ISO strings (or whatever is stored) to JS Date objects
  const createdAt = game.createdAt
    ? new Date(game.createdAt)
    : new Date();
  const endedAt = game.endedAt
    ? new Date(game.endedAt)
    : new Date();

  try {
    await db.execute(
      `INSERT INTO games (game_uuid, winner, created_at, ended_at, total_moves, final_board)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        game.id,       // game_uuid
        game.winner,   // 'X' | 'O' | 'draw'
        createdAt,     // JS Date -> MySQL DATETIME
        endedAt,       // JS Date -> MySQL DATETIME
        totalMoves,
        finalBoard,
      ]
    );
    console.log(`Saved game ${game.id} to MySQL`);
  } catch (err) {
    console.error('Error saving game to MySQL:', err);
  }
}

function addGameToHistory(game) {
  gameHistory.push({
    id: game.id,
    winner: game.winner,
    createdAt: game.createdAt,
    endedAt: game.endedAt,
  });

  if (gameHistory.length > 100) {
    gameHistory.shift();
  }

  // Also persist to MySQL (fire-and-forget)
  saveGameToDB(game);
}

// ---------- REST API (still useful) ----------

// Health
app.get('/health', (req, res) => {
  res.send('OK');
});

// Create a new game
app.post('/api/new-game', (req, res) => {
  const game = createNewGame();
  return res.json({ game });
});

// Get current state of a game
app.get('/api/game/:id', (req, res) => {
  const game = games[req.params.id];
  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }
  return res.json({ game });
});

// Get simple game history
app.get('/api/recent-games', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT
         game_uuid AS id,
         winner,
         created_at AS createdAt,
         ended_at AS endedAt,
         total_moves AS totalMoves,
         final_board AS finalBoard
       FROM games
       ORDER BY ended_at DESC
       LIMIT 20`
    );

    res.json({ games: rows });
  } catch (err) {
    console.error('Error fetching recent games from MySQL:', err);
    res.status(500).json({ error: 'Failed to fetch recent games' });
  }
});

// ---------- Socket.IO setup ----------
const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // Join an existing game as X or O
  socket.on('joinGame', ({ gameId }) => {
    const game = games[gameId];
    if (!game) {
      socket.emit('errorMessage', 'Game not found');
      return;
    }

    let players = gamePlayers[gameId] || { X: null, O: null };
    let symbol = null;

    if (!players.X) {
      players.X = socket.id;
      symbol = 'X';
    } else if (!players.O) {
      players.O = socket.id;
      symbol = 'O';
    } else {
      socket.emit('errorMessage', 'Game room is full (already 2 players).');
      return;
    }

    gamePlayers[gameId] = players;
    socketToGame[socket.id] = { gameId, symbol };

    socket.join(`game:${gameId}`);

    // Tell this client what they are, and send game state
    socket.emit('joinedGame', { gameId, symbol, game });

    // Tell everyone in the room who is connected
    io.to(`game:${gameId}`).emit('playerInfo', {
      gameId,
      players: {
        X: !!players.X,
        O: !!players.O,
      },
    });

    console.log(`Socket ${socket.id} joined game ${gameId} as ${symbol}`);
  });

  // Handle a move from a player
  socket.on('makeMove', ({ index }) => {
    const info = socketToGame[socket.id];
    if (!info) return;

    const { gameId, symbol } = info;
    const game = games[gameId];
    if (!game || !game.active) return;

    if (game.currentPlayer !== symbol) {
      socket.emit('errorMessage', 'Not your turn');
      return;
    }

    if (index < 0 || index > 8 || !Number.isInteger(index)) {
      return;
    }

    if (game.board[index] !== null) {
      return;
    }

    const player = symbol;
    game.board[index] = player;
    game.updatedAt = new Date().toISOString();

    if (checkWin(game.board, player)) {
      game.active = false;
      game.winner = player;
      game.endedAt = new Date().toISOString();
      addGameToHistory(game);
    } else if (checkDraw(game.board)) {
      game.active = false;
      game.winner = 'draw';
      game.endedAt = new Date().toISOString();
      addGameToHistory(game);
    } else {
      game.currentPlayer = player === 'X' ? 'O' : 'X';
    }

    // Broadcast updated state to both players
    io.to(`game:${gameId}`).emit('gameState', { game });
  });

  socket.on('disconnect', () => {
    const info = socketToGame[socket.id];
    if (!info) return;

    const { gameId, symbol } = info;
    delete socketToGame[socket.id];

    const players = gamePlayers[gameId];
    if (players && players[symbol] === socket.id) {
      players[symbol] = null;
      gamePlayers[gameId] = players;

      io.to(`game:${gameId}`).emit('playerInfo', {
        gameId,
        players: {
          X: !!players.X,
          O: !!players.O,
        },
      });
    }

    console.log('Socket disconnected:', socket.id);
  });
});

// ---------- Start server ----------
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
