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

// ... (Keep your startRoomTimer and stopRoomTimer functions exactly as they are) ...
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
// ROUTES & SOCKET.IO (Keep exactly as they are)
// ==========================================
app.get("/", (req, res) => res.render("index"));
app.get("/room/:id", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  if (!rooms[roomId]) createRoom(roomId);
  res.render("room", { roomId });
});

io.on("connection", (socket) => {
    // ... (Keep your existing Socket.IO logic here exactly as it is) ...
    // Copy-paste your existing socket logic: check_room_status, initialize_room, joinRoom, move, disconnect
    // (Omitted here for brevity, but do not delete it in your file)
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
// TELEGRAM BOT LOGIC (UPDATED)
// ==========================================
const bot = new Telegraf(BOT_TOKEN);

bot.command('start', (ctx) => {
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg", 
        {
            caption: "<b>Welcome to Chess Master!</b>\n\nClick below to start a game.",
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("🎮 Create New Game", "create_game")]
            ])
        }
    );
});

// 1. UPDATED CREATE GAME ACTION
bot.action("create_game", (ctx) => {
    const roomId = makeRoomId();
    const gameLink = `${GAME_URL}/room/${roomId}`;
    
    ctx.replyWithPhoto(
        "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg",
        {
            caption: `♟️ <b>Chess Game Created!</b>\n\nRoom ID: <code>${roomId}</code>\n\nTo play with a friend:\n1. Tap 'Share Game'\n2. Choose a friend\n3. Tap the result to send the invite!`,
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.webApp("🚀 Enter The Game", gameLink)],
                // This 'switchToChat' button opens the chat list and types "@botname <roomId>"
                [Markup.button.switchToChat("📤 Share Game", roomId)]
            ])
        }
    );
});

// 2. NEW INLINE QUERY HANDLER
bot.on('inline_query', async (ctx) => {
    const query = ctx.inlineQuery.query.trim();
    let roomId = query;
    let title = "Share Chess Game";
    let description = "Send an invite for this game room.";

    // If user types just "@botname" without ID, let them create a new one
    if (!roomId) {
        roomId = makeRoomId();
        title = "Create New Game";
        description = "Start a fresh chess match.";
    }

    const gameLink = `${GAME_URL}/room/${roomId}`;

    await ctx.answerInlineQuery([
        {
            type: 'article',
            id: roomId,
            title: title,
            description: description,
            thumbnail_url: "https://upload.wikimedia.org/wikipedia/commons/6/6f/ChessSet.jpg",
            input_message_content: {
                message_text: `♟️ <b>Chess Invitation</b>\n\nRoom ID: <code>${roomId}</code>\n\nClick below to join the match!`,
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🚀 Play Chess", web_app: { url: gameLink } }]
                ]
            }
        }
    ], { cache_time: 0 }); // Disable caching so unique IDs are always generated
});

bot.launch();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));