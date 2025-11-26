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
// Replace this with your actual Bot Token
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; 

// Replace this with your actual Render URL
const GAME_URL = "https://telegramchessbot.onrender.com"; 

// IMPORTANT: This MUST match the Short Name you set in @BotFather
const GAME_SHORT_NAME = "Optimal_Chess"; 

// ==========================================
// GAME STATE & SESSION TRACKING
// ==========================================
const rooms = Object.create(null);

// Tracks which room a user is currently hosting/playing in
const userSessions = new Map(); 

// Links Inline Messages (Shared via button) to Rooms
const inlineGameMappings = new Map();

// Links Standard Messages (Forwarded/Groups) to Rooms
const messageGameMappings = new Map();

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
// EXPRESS ROUTES
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

  // 2. CREATOR SAVES SETTINGS
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
      // Auto-assign Logic
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

// 1. Start Command
bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick below to start a game with friends.",
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("🎮 Create New Game", "create_game")]
            ])
        }
    );
});

// 2. Create Game Button Handler
bot.action("create_game", (ctx) => {
    // We send the Game with a "Play" button and a "Share" button
    // The "Play" button MUST be first.
    return ctx.replyWithGame(GAME_SHORT_NAME, Markup.inlineKeyboard([
        [Markup.button.game("♟️ Play Chess")],
        [Markup.button.switchToChat("📤 Share with Friends", "play")]
    ]));
});

// 3. Play Button Handler (Logic for Pairing & Forwarding)
bot.gameQuery((ctx) => {
    let roomId;
    const { inline_message_id, message, from } = ctx.callbackQuery;

    // --- CASE 1: SHARED VIA INLINE BUTTON ---
    if (inline_message_id) {
        if (inlineGameMappings.has(inline_message_id)) {
            roomId = inlineGameMappings.get(inline_message_id);
        } else {
            roomId = makeRoomId();
            inlineGameMappings.set(inline_message_id, roomId);
        }
    } 
    // --- CASE 2: FORWARDED MESSAGE (Group Pairing) ---
    else if (message) {
        // Check if the message is forwarded
        const forwardedFrom = message.forward_from || 
                             (message.forward_origin && message.forward_origin.sender_user);

        // If forwarded, try to find the room user 1 is in
        if (forwardedFrom) {
            const hostsRoom = userSessions.get(forwardedFrom.id);
            if (hostsRoom) {
                roomId = hostsRoom;
            }
        }
        
        // If we still don't have a room, check if this exact message has a room assigned
        if (!roomId) {
            const messageKey = `${message.chat.id}_${message.message_id}`;
            if (messageGameMappings.has(messageKey)) {
                roomId = messageGameMappings.get(messageKey);
            } else {
                roomId = makeRoomId();
                messageGameMappings.set(messageKey, roomId);
            }
        }
    }
    // --- CASE 3: FALLBACK ---
    else {
        roomId = makeRoomId();
    }

    // Save this as the "Active Room" for the user who just clicked
    userSessions.set(from.id, roomId);

    const gameUrl = `${GAME_URL}/room/${roomId}`;
    return ctx.answerGameQuery(gameUrl);
});

// 4. Inline Query (Share Button)
bot.on('inline_query', (ctx) => {
    const userId = ctx.from.id;
    let roomId = userSessions.get(userId);
    
    // Fallback
    if (!roomId) roomId = "new_game";

    const results = [{
        type: 'game',
        id: roomId,
        game_short_name: GAME_SHORT_NAME,
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.game("♟️ Play Chess")]
        ])
    }];
    return ctx.answerInlineQuery(results);
});

// 5. Save Room ID when game is shared
bot.on('chosen_inline_result', (ctx) => {
    const { inline_message_id, result_id } = ctx.update.chosen_inline_result;
    if (result_id && result_id !== "new_game") {
        inlineGameMappings.set(inline_message_id, result_id);
    }
});

bot.launch();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));