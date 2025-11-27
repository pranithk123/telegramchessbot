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
// Replace with your actual Bot Token
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; 

// Replace with your actual Render URL
const GAME_URL = "https://telegramchessbot.onrender.com"; 

// MUST match the Short Name in @BotFather
const GAME_SHORT_NAME = "Optimal_Chess"; 

// ==========================================
// GAME STATE & SESSION MANAGEMENT
// ==========================================
const rooms = Object.create(null);

// Tracks the Room ID a user is trying to join
const userSessions = new Map(); 

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

  // 2. INITIALIZE ROOM (Creator Settings)
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
// TELEGRAM BOT LOGIC (DEEP LINKING IMPLEMENTED)
// ==========================================
const bot = new Telegraf(BOT_TOKEN);

// 1. START COMMAND
// This handles BOTH standard "/start" AND deep links like "/start join_12345"
bot.start((ctx) => {
    const payload = ctx.startPayload; // This captures "join_12345"
    
    // SCENARIO A: User clicked an Invite Link
    if (payload && payload.startsWith("join_")) {
        const roomId = payload.split("_")[1];
        
        // Save the Room ID for this specific user
        userSessions.set(ctx.from.id, roomId);
        
        // Send them a FRESH game message
        // Since this message is new, the "Play" button will work perfectly
        return ctx.replyWithGame(GAME_SHORT_NAME, Markup.inlineKeyboard([
             [Markup.button.game("♟️ Launch Game")]
        ]));
    }

    // SCENARIO B: User just typed /start (Home Screen)
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick below to create a game.",
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("🎮 Create New Game", "create_game")]
            ])
        }
    );
});

// 2. CREATE GAME ACTION
// Instead of sending a game, we send an "Invite Card" with a URL
bot.action("create_game", async (ctx) => {
    const roomId = makeRoomId();
    // Ensure room exists in memory
    if(!rooms[roomId]) createRoom(roomId);

    // Create the Deep Link: t.me/BotName?start=join_ROOMID
    const botUsername = ctx.botInfo.username;
    const deepLink = `https://t.me/${botUsername}?start=join_${roomId}`;

    await ctx.replyWithPhoto("https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", {
        caption: `♟️ <b>Chess Game Created!</b>\n\nRoom ID: <code>${roomId}</code>\n\nForward this message to a friend so they can join!`,
        parse_mode: "HTML",
        reply_markup: {
            inline_keyboard: [
                // THIS URL BUTTON SURVIVES FORWARDING
                [{ text: "♟️ Play Chess", url: deepLink }],
                // Share button for inline mode (optional, but good to have)
                [{ text: "📤 Share", switch_inline_query: "play" }]
            ]
        }
    });
});

// 3. LAUNCH GAME
// This triggers when user clicks "Launch Game" (from Step 1)
bot.gameQuery((ctx) => {
    // We look up which room this user is supposed to be in
    let roomId = userSessions.get(ctx.from.id);
    
    // Fallback if session is lost (e.g. server restart)
    if (!roomId) {
        roomId = makeRoomId();
        userSessions.set(ctx.from.id, roomId);
    }

    const gameUrl = `${GAME_URL}/room/${roomId}`;
    return ctx.answerGameQuery(gameUrl);
});

// 4. INLINE QUERY (Share Button)
bot.on('inline_query', (ctx) => {
    const userId = ctx.from.id;
    let roomId = userSessions.get(userId);
    if (!roomId) roomId = "new_game";

    // Even the inline query uses the deep link now!
    const deepLink = `https://t.me/${ctx.botInfo.username}?start=join_${roomId}`;

    const results = [{
        type: 'article',
        id: roomId,
        title: 'Play Chess',
        description: 'Click to join my Chess Game',
        thumb_url: "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg",
        input_message_content: {
            message_text: `♟️ <b>Join my Chess Game!</b>\n\nClick the button below to play.`,
            parse_mode: "HTML"
        },
        reply_markup: {
            inline_keyboard: [
                [{ text: "♟️ Play Chess", url: deepLink }]
            ]
        }
    }];
    return ctx.answerInlineQuery(results);
});

bot.launch();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));