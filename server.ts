import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const db = new Database("mapchaos.db");

// Initialize Database
db.exec(`
  CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    title TEXT,
    host_id TEXT,
    active_members TEXT,
    ai_thinking INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nickname TEXT,
    avatar_url TEXT,
    status_emoji TEXT,
    rps_wins INTEGER DEFAULT 0,
    undo_used INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pins (
    id TEXT PRIMARY KEY,
    trip_id TEXT,
    room_id TEXT,
    place_id TEXT,
    name TEXT,
    lat REAL,
    lng REAL,
    assigned_day INTEGER DEFAULT 0,
    time_slot TEXT,
    order_idx INTEGER DEFAULT 0,
    locked_by TEXT,
    locked_until TEXT
  );

  CREATE TABLE IF NOT EXISTS canvas_events (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    user_id TEXT,
    type TEXT,
    payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_undone INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT,
    sender_id TEXT,
    msg_type TEXT,
    content TEXT,
    target_user_id TEXT,
    action_payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Socket.io Logic
  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join_room", (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
      
      // Send initial data
      const trips = db.prepare(`SELECT * FROM trips WHERE room_id = ?`).all(roomId);
      socket.emit("SYNC_TRIPS", trips);

      // Notify others about presence
      io.to(roomId).emit("USER_JOINED", { userId: socket.id });
    });

    socket.on("UPDATE_PROFILE", (data) => {
      const { roomId, userId, nickname, avatarUrl } = data;
      db.prepare(`
        INSERT INTO users (id, nickname, avatar_url) 
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname, avatar_url=excluded.avatar_url
      `).run(userId, nickname, avatarUrl);
      io.to(roomId).emit("PROFILE_UPDATED", { userId, nickname, avatarUrl });
    });

    socket.on("MOVE_CURSOR", (data) => {
      const { roomId, userId, center } = data;
      socket.to(roomId).emit("USER_CURSOR_MOVED", { userId, center });
    });

    socket.on("CREATE_TRIP", (data) => {
      const { roomId, title } = data;
      const id = `trip_${Date.now()}`;
      db.prepare(`INSERT INTO trips (id, room_id, title) VALUES (?, ?, ?)`).run(id, roomId, title);
      io.to(roomId).emit("TRIP_CREATED", { id, roomId, title });
    });

    socket.on("GET_PINS", (tripId) => {
      const pins = db.prepare(`SELECT * FROM pins WHERE trip_id = ?`).all(tripId);
      socket.emit("SYNC_PINS", pins);
    });

    socket.on("DRAW_ACTION", (data) => {
      const { roomId, userId, type, payload } = data;
      const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      db.prepare(`
        INSERT INTO canvas_events (id, room_id, user_id, type, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, roomId, userId, type, JSON.stringify(payload));

      io.to(roomId).emit("SYNC_ACTION", {
        actionId: id,
        userId,
        type,
        payload
      });
    });

    socket.on("UNDO_REQUEST", (roomId) => {
      const lastEvent = db.prepare(`
        SELECT * FROM canvas_events 
        WHERE room_id = ? AND is_undone = 0 
        ORDER BY created_at DESC LIMIT 1
      `).get(roomId) as any;

      if (lastEvent) {
        db.prepare(`UPDATE canvas_events SET is_undone = 1 WHERE id = ?`).run(lastEvent.id);
        io.to(roomId).emit("UNDO_EXECUTE", { actionId: lastEvent.id });
      }
    });

    socket.on("SUMMON_USER", (data) => {
      const { roomId, fromId, targetUserId, coords } = data;
      const expiresAt = new Date(Date.now() + 30000).toISOString();
      
      io.to(roomId).emit("SUMMON_ALERT", {
        fromId,
        targetUserId,
        coords,
        expiresAt
      });
    });

    socket.on("DRAG_PIN", (data) => {
      const { roomId, pinId, userId } = data;
      // Simple conflict detection: check if someone else is already dragging
      // In a real app, we'd use a more robust lock mechanism
      socket.to(roomId).emit("PIN_DRAG_START", { pinId, userId });
    });

    socket.on("BATTLE_START_TRIGGER", (data) => {
      const { roomId, pinId, userA, userB } = data;
      io.to(roomId).emit("BATTLE_START", { pinId, userA, userB });
    });

    socket.on("RPS_CHOICE", (data) => {
      const { roomId, battleId, userId, choice } = data;
      io.to(roomId).emit("RPS_CHOICE_RECEIVED", { battleId, userId, choice });
    });

    socket.on("BATTLE_RESULT", (data) => {
      const { roomId, winnerId, pinId } = data;
      io.to(roomId).emit("BATTLE_RESULT_SYNC", { winnerId, pinId });
    });

    socket.on("DROP_PIN", (data) => {
      const { roomId, pinId, targetDay, userId } = data;
      io.to(roomId).emit("START_VOTE", {
        voteId: `vote_${Date.now()}`,
        pinId,
        targetDay,
        initiatorId: userId,
        expiresAt: new Date(Date.now() + 15000).toISOString()
      });
    });

    socket.on("SUBMIT_VOTE", (data) => {
      const { roomId, voteId, userId, isAgree } = data;
      io.to(roomId).emit("VOTE_RECEIVED", { voteId, userId, isAgree });
    });

    socket.on("VOTE_FINAL_RESULT", (data) => {
      const { roomId, success, pinId, targetDay } = data;
      if (success) {
        db.prepare(`UPDATE pins SET assigned_day = ? WHERE id = ?`).run(targetDay, pinId);
      }
      io.to(roomId).emit("VOTE_RESULT_SYNC", { success, pinId, targetDay });
    });

    socket.on("SET_PIN_TIME", (data) => {
      const { roomId, pinId, timeSlot, day } = data;
      db.prepare(`UPDATE pins SET time_slot = ?, assigned_day = ? WHERE id = ?`).run(timeSlot, day, pinId);
      io.to(roomId).emit("PIN_TIME_UPDATED", { pinId, timeSlot, day });
    });

    socket.on("SEND_MESSAGE", (data) => {
      const { roomId, userId, content } = data;
      const id = `msg_${Date.now()}`;
      
      db.prepare(`
        INSERT INTO messages (id, room_id, sender_id, msg_type, content)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, roomId, userId, "text", content);

      io.to(roomId).emit("SYNC_MESSAGE", {
        id,
        userId,
        content,
        createdAt: new Date().toISOString()
      });
    });

    socket.on("SET_AI_STATE", (data) => {
      const { roomId, isThinking } = data;
      db.prepare(`UPDATE rooms SET ai_thinking = ? WHERE id = ?`).run(isThinking ? 1 : 0, roomId);
      io.to(roomId).emit("AI_STATE", { isThinking });
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
