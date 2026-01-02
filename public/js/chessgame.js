const socket = io();
const chess = new Chess();
const tg = window.Telegram.WebApp;
tg.expand();

let boardEl = null;
let role = null;
let dragged = null;
let source = null;
let selectedSource = null;

// Sounds
const moveSound = new Audio("/sounds/move.mp3");
const captureSound = new Audio("/sounds/capture.mp3");
const endSound = new Audio("/sounds/gameover.mp3");

const fmt = s => `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
const pieceImage = p => `/pieces/${p.color}${p.type.toUpperCase()}.svg`;

// ==========================================
// 1. LOBBY LOGIC
// ==========================================
socket.on("connect", () => {
    socket.emit('check_room_status', ROOM_ID);
});

socket.on('room_status', (status) => {
    const modal = document.getElementById('setup-modal');
    const waiting = document.getElementById('waiting');
    
    if (status === 'empty') {
        // Show Creator Setup
        modal.classList.remove('hidden');
        waiting.classList.add('hidden');
    } else {
        // Auto-Join Guest
        modal.classList.add('hidden');
        waiting.classList.remove('hidden');
        socket.emit('joinRoom', ROOM_ID);
    }
});

window.confirmSettings = function(color) {
    const time = document.getElementById('time-slider').value;
    
    // Lock settings
    socket.emit('initialize_room', {
        roomId: ROOM_ID,
        settings: { time: time * 60, color: color }
    });

    // Join self
    socket.emit('joinRoom', { roomId: ROOM_ID, role: color });
    
    document.getElementById('setup-modal').classList.add('hidden');
    document.getElementById('waiting').classList.remove('hidden');
};

// ==========================================
// 2. GAME LOGIC
// ==========================================
socket.on("init", data => {
  role = data.role;
  document.getElementById("waiting").classList.add("hidden");
  document.getElementById("game").classList.remove("hidden");

  if (data.fen) chess.load(data.fen);
  renderBoard();
  updateTimers(data.timers);
});

socket.on("boardstate", fen => {
  chess.load(fen);
  renderBoard();
});

socket.on("move", mv => {
  chess.move(mv);
  renderBoard();
  moveSound.play();
});

socket.on("timers", t => updateTimers(t));

socket.on("gameover", msg => {
    endSound.play();
    tg.showPopup({ title: "Game Over", message: msg, buttons: [{type:"close"}] });
});

// ==========================================
// 3. BOARD RENDERING
// ==========================================
function renderBoard() {
  boardEl = document.querySelector(".chessboard");
  if (!boardEl) return;
  boardEl.innerHTML = "";

  let visualRow = (role === "b") ? (7 - r) : r;
let visualCol = (role === "b") ? (7 - c) : c;

div.style.left = `${visualCol * 42.5}px`;
div.style.top = `${visualRow * 42.5}px`;
  
  const board = chess.board();
  board.forEach((row, r) => {
    row.forEach((sq, c) => {
      const div = document.createElement("div");
      div.classList.add("square", (r + c) % 2 ? "dark" : "light");
      div.dataset.row = r;
      div.dataset.col = c;
      div.style.left = `${c * 42.5}px`;
      div.style.top = `${r * 42.5}px`;

      if (sq) {
        const p = document.createElement("div");
        p.classList.add("piece");
        const img = document.createElement("img");
        img.src = pieceImage(sq);
        img.classList.add("piece-img");
        p.appendChild(img);
        div.appendChild(p);
        
        // Drag Logic
        if (role === sq.color) {
            p.draggable = true;
            p.addEventListener("dragstart", (e) => {
                dragged = p;
                source = { r, c };
                // Hide ghost
                const blank = document.createElement('canvas');
                e.dataTransfer.setDragImage(blank,0,0);
            });
            // Touch Logic
             p.addEventListener("click", (e) => {
                e.stopPropagation();
                handleTap(r, c);
            });
        }
      }
      
      div.addEventListener("dragover", e => e.preventDefault());
      div.addEventListener("drop", e => {
        if(dragged) handleMove(source, { r, c });
      });
      div.addEventListener("click", () => handleTap(r, c));
      
      boardEl.appendChild(div);
    });
  });

  if (role === "b") boardEl.classList.add("flipped");
  else boardEl.classList.remove("flipped");
}

function handleTap(r, c) {
    if (selectedSource) {
        handleMove(selectedSource, { r, c });
        selectedSource = null;
        document.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
    } else if (chess.board()[r][c] && chess.board()[r][c].color === role) {
        selectedSource = { r, c };
        const sq = document.querySelector(`.square[data-row='${r}'][data-col='${c}']`);
        if(sq) sq.classList.add("selected");
    }
}

function handleMove(s, t) {
  const move = {
    from: `${String.fromCharCode(97 + s.c)}${8 - s.r}`,
    to: `${String.fromCharCode(97 + t.c)}${8 - t.r}`,
    promotion: "q"
  };
  socket.emit("move", { roomId: ROOM_ID, move: move });
}

function updateTimers(t) {
  const top = document.getElementById("top-timer");
  const bot = document.getElementById("bottom-timer");
  if (role === "b") { bot.innerText = fmt(t.b); top.innerText = fmt(t.w); }
  else { bot.innerText = fmt(t.w); top.innerText = fmt(t.b); }
}
