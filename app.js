const express = require("express");
const socketio = require("socket.io");
const http = require("http");
const https = require("https");
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
const BOT_TOKEN = "8332605905:AAEPxxEvTpkiYO6LjV7o1-ASa5ufIqxtGGs"; // <--- PASTE TOKEN HERE
const GAME_URL = "https://chessit.onrender.com"; 
const GAME_SHORT_NAME = "Optimal_Chess"; 
const PORT = process.env.PORT || 3000; 

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

  socket.on("initialize_room", (data) => {
      const { roomId, settings } = data;
      const rId = roomId.toUpperCase();
      if (!rooms[rId]) return;

      rooms[rId].settings = settings;
      const t = parseInt(settings.time) || 600;
      rooms[rId].timers = { w: t, b: t };
  });

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
// TELEGRAM BOT LOGIC (WEBHOOK SUPPORT)
// ==========================================
const agent = new https.Agent({ family: 4 });
const bot = new Telegraf(BOT_TOKEN, { telegram: { agent } });

bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick below to start.",
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [[
                    { text: "🎮 Create New Game", callback_data: "create_game" }
                ]]
            }
        }
    );
});

bot.action("create_game", (ctx) => {
    const roomId = makeRoomId();
    const shareUrl = `https://t.me/${ctx.botInfo.username}/OptimalChess?startapp=${roomId}`;

    ctx.replyWithGame(GAME_SHORT_NAME, {
        reply_markup: {
            inline_keyboard: [
                [{ text: "♟️ Open Chess", callback_game: {} }],
                [{ text: "🚀 Play Room " + roomId, url: shareUrl }],
                [{ text: "📤 Share Game", switch_inline_query: roomId }]
            ]
        }
    });
});

bot.on('inline_query', (ctx) => {
    const roomId = ctx.inlineQuery.query || makeRoomId(); 
    const shareUrl = `https://t.me/${ctx.botInfo.username}/OptimalChess?startapp=${roomId}`;

    const result = {
        type: 'game',
        id: roomId,
        game_short_name: GAME_SHORT_NAME,
        reply_markup: {
            inline_keyboard: [
                [{ text: "♟️ Open Chess", callback_game: {} }],
                [{ text: "🚀 Play Room " + roomId, url: shareUrl }]
            ]
        }
    };

    return ctx.answerInlineQuery([result], { cache_time: 0 });
});

bot.gameQuery((ctx) => {
    return ctx.answerGameQuery(GAME_URL);
});

// ==========================================
// SERVER LAUNCH (WEBHOOK vs POLLING)
// ==========================================

// 1. Generate a random path for the webhook
const secretPath = `/telegraf/${process.env.SECRET_PATH || "my-secret-path"}`;

// 2. Set up the webhook listener on Express
app.use(bot.webhookCallback(secretPath));

// 3. Start Server & Set Webhook
server.listen(PORT, async () => {
    console.log(`✅ Server running on port ${PORT}`);

    // Check if running on Render
    if (process.env.RENDER || GAME_URL.includes('render')) {
        console.log("🚀 Running on Render -> Setting Webhook...");
        
        const webhookUrl = `${GAME_URL}${secretPath}`;
        
        try {
            // Explicitly set the webhook to the known URL
            const success = await bot.telegram.setWebhook(webhookUrl);
            
            if (success) {
                console.log(`✅ Webhook successfully set to: ${webhookUrl}`);
            } else {
                console.error("❌ Telegram API returned false for setWebhook");
            }
        } catch (err) {
            console.error("❌ Failed to set webhook:", err);
        }
    } else {
        console.log("💻 Running locally -> Starting Polling...");
        bot.launch();
    }
});