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
// CONFIGURATION (UPDATE THESE!)
// ==========================================
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; 
const GAME_URL = "https://telegramchessbot.onrender.com"; 

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
    timers: { w: 600, b: 600 }, // Default 10 min
    timerInterval: null,
    isTimerRunning: false,
    settings: null // null = not set up yet
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
    if (!turn) return;

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
  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  room.isTimerRunning = false;
}

// ==========================================
// ROUTES
// ==========================================
app.get("/", (req, res) => res.render("index"));
app.get("/room/:id", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!rooms[roomId]) createRoom(roomId);
  res.render("room", { roomId });
});

// ==========================================
// SOCKET.IO LOGIC
// ==========================================
io.on("connection", (socket) => {
  // 1. PRIVATE LOBBY CHECK
  socket.on("check_room_status", (roomId) => {
    // Don't uppercase inline IDs (they are case-sensitive!)
    // roomId = roomId.toUpperCase(); <--- REMOVE THIS LINE
    
    // Create the room if it doesn't exist (First player clicked Play)
    if (!rooms[roomId]) createRoom(roomId);
    
    const room = rooms[roomId];
    
    if (!room.settings) {
        socket.emit("room_status", "empty"); 
    } else {
        socket.emit("room_status", "waiting");
    }
  });

  // 2. CREATOR SAVES SETTINGS
  socket.on("initialize_room", (data) => {
      const { roomId, settings } = data;
      const rId = roomId;
      if (!rooms[rId]) return;

      rooms[rId].settings = settings;
      const t = parseInt(settings.time) || 600;
      rooms[rId].timers = { w: t, b: t };
  });

  // 3. JOIN ROOM
  socket.on("joinRoom", data => {
    let roomId, forcedRole;
    if (typeof data === "string") roomId = data;
    else { roomId = data.roomId ; forcedRole = data.role; }

    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];

    socket.join(roomId);
    socket.data.currentRoom = roomId;

    // Priority: Forced Role (Creator)
    if (forcedRole === "w") {
      room.white = socket.id;
      socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
    } 
    else if (forcedRole === "b") {
      room.black = socket.id;
      socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
    }
    // Auto-Assign (Guest)
    else {
      if (room.white && !room.black) {
        room.black = socket.id;
        socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
      }
      else if (room.black && !room.white) {
        room.white = socket.id;
        socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
      }
      else {
        room.watchers.add(socket.id);
        socket.emit("init", { role: null, fen: room.chess.fen(), timers: room.timers });
      }
    }

    if (room.white && room.black) {
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);
    }
  });

  // 4. MOVE HANDLING
  socket.on("move", (data) => {
    try {
      const roomId = socket.data.currentRoom || data.roomId;
      if (!roomId || !rooms[roomId]) return;
      const room = rooms[roomId];
      const mv = data.move;

      const turn = room.chess.turn();
      if ((turn === "w" && socket.id !== room.white) || (turn === "b" && socket.id !== room.black)) return;

      const result = room.chess.move(mv);
      if (!result) return;

      io.to(roomId).emit("move", mv);
      io.to(roomId).emit("boardstate", room.chess.fen());
      io.to(roomId).emit("timers", room.timers);

      stopRoomTimer(roomId);
      startRoomTimer(roomId);

      if (room.chess.isGameOver()) {
        stopRoomTimer(roomId);
        let winner = "";
        if (room.chess.isCheckmate()) winner = room.chess.turn() === "w" ? "Black" : "White";
        else if (room.chess.isDraw()) winner = "Draw";
        else winner = "Game Over";
        io.to(roomId).emit("gameover", winner);
      }
    } catch (err) {}
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.currentRoom;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      if (room.white === socket.id) room.white = null;
      if (room.black === socket.id) room.black = null;
      if (!room.white && !room.black) {
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

// Replace this with the Short Name you got from BotFather (e.g. 'chess')
const GAME_SHORT_NAME = "Optimal_Chess"; 

// 1. START COMMAND
// Instead of creating a room immediately, we give a button to "Switch to Inline Mode"
bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nTo play with a friend, click the button below to create a game table.",
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    // "switch_inline_query_current_chat" opens the input field with your bot's name
                    [{ text: "🎮 Create New Game", switch_inline_query_current_chat: "create" }]
                ]
            }
        }
    );
});

// 2. HANDLE INLINE QUERY (This creates the "Forwardable" Game Message)
bot.on('inline_query', async (ctx) => {
    // We answer with a "Game" result. 
    // This creates the message with the "via @YourBot" tag.
    const results = [{
        type: 'game',
        id: '1', // Just a unique ID for this result item
        game_short_name: GAME_SHORT_NAME,
        // You can add a custom reply_markup (buttons) here if you want extra links
        // reply_markup: { inline_keyboard: [[{text: "Join Channel", url: "..."}]] } 
    }];
    
    return ctx.answerInlineQuery(results);
});

// 3. HANDLE "PLAY" BUTTON CLICKS
bot.on('callback_query', (ctx) => {
    // Check if the clicked button is a Game Button
    if (ctx.callbackQuery.game_short_name !== GAME_SHORT_NAME) return;

    // "inline_message_id" is the unique ID that PERSISTS when forwarded!
    const gameId = ctx.callbackQuery.inline_message_id;

    if (gameId) {
        // We use this ID as the Room ID
        const gameUrl = `${GAME_URL}/room/${gameId}`;
        return ctx.answerGameQuery(gameUrl);
    } else {
        // Fallback (if they somehow clicked a non-inline game)
        return ctx.answerGameQuery(GAME_URL);
    }
});

bot.launch();
// ... rest of server code ...
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));