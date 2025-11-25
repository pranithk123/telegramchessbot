const express = require("express");
const socketio = require("socket.io");
const http = require("http");
const { Chess } = require("chess.js");
const path = require("path");
const crypto = require("crypto");
const { Telegraf, Markup } = require('telegraf');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// CONFIGURATION
// ==========================================
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; 
const GAME_URL = "https://telegramchessbot.onrender.com"; 
const GAME_SHORT_NAME = "Optimal_Chess"; // MUST match the short name created in BotFather

// ==========================================
// GAME STATE
// ==========================================
const rooms = Object.create(null);
const makeRoomId = () => crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase();

function createRoom(roomId) {
  const room = {
    chess: new Chess(),
    white: null,
    black: null,
    watchers: new Set(),
    timers: { w: 600, b: 600 },
    timerInterval: null,
    isTimerRunning: false,
    settings: null 
  };
  rooms[roomId] = room;
  return room;
}

function startRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room || room.isTimerRunning) return;
  room.isTimerRunning = true;
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.timerInterval = setInterval(() => {
    const turn = room.chess.turn();
    if (room.timers[turn] > 0) room.timers[turn]--;
    io.to(roomId).emit("timers", room.timers);
    if (room.timers[turn] <= 0) {
      clearInterval(room.timerInterval);
      room.isTimerRunning = false;
      const winner = turn === "w" ? "Black" : "White";
      io.to(roomId).emit("gameover", `${winner} (timeout)`);
    }
  }, 1000);
}

function stopRoomTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);
  room.isTimerRunning = false;
}

// ==========================================
// EXPRESS ROUTES
// ==========================================
app.get("/", (req, res) => res.render("index"));

app.get("/room/:id", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  // We don't force create here; socket logic handles it if missing
  res.render("room", { roomId });
});

// ==========================================
// SOCKET.IO LOGIC
// ==========================================
io.on("connection", (socket) => {
  // 1. CHECK/CREATE ROOM
  socket.on("check_room_status", (roomId) => {
    roomId = roomId.toUpperCase();
    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];
    
    // Logic: If settings exist, it's a ready game. If not, it's new.
    if (!room.settings) socket.emit("room_status", "empty"); 
    else socket.emit("room_status", "waiting");
  });

  // 2. INITIALIZE ROOM (Creator)
  socket.on("initialize_room", (data) => {
      const { roomId, settings } = data;
      const rId = roomId.toUpperCase();
      if (!rooms[rId]) return;
      rooms[rId].settings = settings;
      const t = parseInt(settings.time) || 600;
      rooms[rId].timers = { w: t, b: t };
  });

  // 3. JOIN ROOM
  socket.on("joinRoom", data => {
    let roomId, forcedRole;
    if (typeof data === "string") roomId = data.toUpperCase();
    else { roomId = data.roomId.toUpperCase(); forcedRole = data.role; }

    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];
    socket.join(roomId);
    socket.data.currentRoom = roomId;

    // Role Assignment Logic
    let assignedRole = null;
    if (forcedRole) {
        if(forcedRole === 'w' && !room.white) { room.white = socket.id; assignedRole = 'w'; }
        else if(forcedRole === 'b' && !room.black) { room.black = socket.id; assignedRole = 'b'; }
    }
    
    if (!assignedRole) {
        if (!room.white) { room.white = socket.id; assignedRole = 'w'; }
        else if (!room.black) { room.black = socket.id; assignedRole = 'b'; }
        else assignedRole = 'spectator';
    }

    socket.emit("init", { role: assignedRole, fen: room.chess.fen(), timers: room.timers });

    if (room.white && room.black) {
      io.to(roomId).emit("boardstate", room.chess.fen());
    }
  });

  // 4. MOVE LOGIC
  socket.on("move", (data) => {
    try {
      const roomId = socket.data.currentRoom || data.roomId;
      if (!roomId || !rooms[roomId]) return;
      const room = rooms[roomId];
      const turn = room.chess.turn();
      
      // Validate Turn
      if ((turn === "w" && socket.id !== room.white) || (turn === "b" && socket.id !== room.black)) return;

      const result = room.chess.move(data.move);
      if (result) {
        io.to(roomId).emit("move", data.move);
        io.to(roomId).emit("boardstate", room.chess.fen());
        io.to(roomId).emit("timers", room.timers);
        stopRoomTimer(roomId);
        startRoomTimer(roomId);

        if (room.chess.isGameOver()) {
            stopRoomTimer(roomId);
            io.to(roomId).emit("gameover", "Game Over");
        }
      }
    } catch (e) { console.error(e); }
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.currentRoom;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (room.white === socket.id) room.white = null;
      if (room.black === socket.id) room.black = null;
      // Clean up empty rooms if needed
      if (!room.white && !room.black && !room.watchers.size) {
          stopRoomTimer(roomId);
          delete rooms[roomId];
      }
    }
  });
});

// ==========================================
// TELEGRAM BOT LOGIC
// ==========================================
const bot = new Telegraf(BOT_TOKEN);

// 1. Send the Game Launcher
bot.command('start', (ctx) => {
    return ctx.replyWithGame(GAME_SHORT_NAME);
});

// 2. Handle the "Play" button click
bot.gameQuery((ctx) => {
    // We redirect the user to the MAIN MENU (index) 
    // From there, they can click "Play with Friend" to create a room
    // OR "Quickplay" to matchmake.
    
    // NOTE: If you want to support specific room joining via Deep Links,
    // you would check ctx.callbackQuery.game_short_name logic here.
    
    const url = `${GAME_URL}/`; 
    return ctx.answerGameQuery(url);
});

// 3. Optional: Handle "Share" via Inline Mode
// If you use 'switchInlineQuery' in your frontend, this handles it.
bot.on('inline_query', (ctx) => {
    const query = ctx.inlineQuery.query;
    
    // If query is "share", send a fresh Game Message
    // This allows the user to share the "Launcher" to any chat
    return ctx.answerInlineQuery([{
        type: 'game',
        id: '0',
        game_short_name: GAME_SHORT_NAME
    }]);
});

bot.launch();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));