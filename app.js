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
const GAME_SHORT_NAME = "Optimal_Chess"; // Matches your screenshot

// ==========================================
// SESSION MANAGEMENT
// ==========================================
const rooms = Object.create(null);

// Mappings: Inline Message ID -> Room ID
// This is the core of the "Forwarding" fix. 
// Inline IDs are permanent, so they survive forwarding.
const inlineGameMappings = new Map(); 

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
  // 1. CHECK STATUS
  socket.on("check_room_status", (roomId) => {
    roomId = roomId.toUpperCase();
    if (!rooms[roomId]) createRoom(roomId);
    const room = rooms[roomId];
    
    if (!room.settings) {
        socket.emit("room_status", "empty"); 
    } else {
        socket.emit("room_status", "waiting");
    }
  });

  // 2. INITIALIZE ROOM
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

    if (forcedRole === "w") {
      room.white = socket.id;
      socket.emit("init", { role: "w", fen: room.chess.fen(), timers: room.timers });
    } 
    else if (forcedRole === "b") {
      room.black = socket.id;
      socket.emit("init", { role: "b", fen: room.chess.fen(), timers: room.timers });
    }
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

// 1. START COMMAND
// This is what the user sees first.
bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick the button below to create a game.",
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                // CRITICAL: This button switches to Inline Mode in the CURRENT chat.
                // This mimics the "via @Bot" behavior.
                [Markup.button.switchToCurrentChat("🎮 Create New Game", "create")]
            ])
        }
    );
});

// 2. INLINE QUERY HANDLER
// This provides the "Game Message" that appears in the popup menu.
bot.on('inline_query', (ctx) => {
    const roomId = makeRoomId(); // We prepare a fresh ID

    const results = [{
        type: 'game',
        id: roomId, // We stash the Room ID in the result ID
        game_short_name: GAME_SHORT_NAME,
        reply_markup: Markup.inlineKeyboard([
            // This button WILL survive forwarding because it's part of an Inline Message
            [Markup.button.game("♟️ Play Chess")],
            // A helper share button
            [Markup.button.switchToChat("📤 Share with Friends", "create")] 
        ])
    }];
    
    // cache_time: 0 is important so every click gets a fresh Room ID
    return ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
});

// 3. CHOSEN INLINE RESULT (The Linker)
// This fires when the user TAPS the game in the menu to send it.
// This gives us the PERMANENT inline_message_id.
bot.on('chosen_inline_result', (ctx) => {
    const { inline_message_id, result_id } = ctx.update.chosen_inline_result;
    
    // result_id is the roomId we generated in step 2
    if (result_id) {
        if(!rooms[result_id]) createRoom(result_id);
        
        // We map the PERMANENT message ID to the Room ID
        inlineGameMappings.set(inline_message_id, result_id);
        console.log(`✅ Game Created (Inline)! Room: ${result_id}`);
    }
});

// 4. GAME QUERY HANDLER (The Player)
// This handles the "Play" button click.
bot.gameQuery((ctx) => {
    const { inline_message_id } = ctx.callbackQuery;
    let roomId;

    // Because we used Inline Mode, this ID exists and persists across forwards
    if (inline_message_id && inlineGameMappings.has(inline_message_id)) {
        roomId = inlineGameMappings.get(inline_message_id);
    } else {
        // Fallback (should rarely happen if inline feedback is on)
        roomId = makeRoomId();
    }

    const gameUrl = `${GAME_URL}/room/${roomId}`;
    return ctx.answerGameQuery(gameUrl);
});

bot.launch();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));