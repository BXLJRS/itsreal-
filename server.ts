import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import Database from "better-sqlite3";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Database Abstraction ---
const isProd = process.env.NODE_ENV === "production";
const databaseUrl = process.env.DATABASE_URL;

let db: any;
let pgPool: pg.Pool | null = null;

if (databaseUrl) {
  console.log("Using PostgreSQL database");
  pgPool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false }
  });
} else {
  console.log("Using SQLite database");
  db = new Database("mapchaos.db");
}

async function query(sql: string, params: any[] = []) {
  if (pgPool) {
    const res = await pgPool.query(sql.replace(/\?/g, (_, i) => `$${i + 1}`), params);
    return res.rows;
  } else {
    return db.prepare(sql).all(...params);
  }
}

async function get(sql: string, params: any[] = []) {
  if (pgPool) {
    const res = await pgPool.query(sql.replace(/\?/g, (_, i) => `$${i + 1}`), params);
    return res.rows[0];
  } else {
    return db.prepare(sql).get(...params);
  }
}

async function execute(sql: string, params: any[] = []) {
  if (pgPool) {
    await pgPool.query(sql.replace(/\?/g, (_, i) => `$${i + 1}`), params);
  } else {
    db.prepare(sql).run(...params);
  }
}

async function initDb() {
  const schema = `
    CREATE TABLE IF NOT EXISTS trips (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      title TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

  if (pgPool) {
    await pgPool.query(schema);
  } else {
    db.exec(schema);
  }
}

async function startServer() {
  await initDb();

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

    socket.on("join_room", async (roomId) => {
      socket.join(roomId);
      console.log(`User ${socket.id} joined room ${roomId}`);
      
      // Send initial data
      const trips = await query(`SELECT * FROM trips WHERE room_id = ?`, [roomId]);
      socket.emit("SYNC_TRIPS", trips);

      // Notify others about presence
      io.to(roomId).emit("USER_JOINED", { userId: socket.id });
    });

    socket.on("UPDATE_PROFILE", async (data) => {
      const { roomId, userId, nickname, avatarUrl } = data;
      
      if (pgPool) {
        await pgPool.query(`
          INSERT INTO users (id, nickname, avatar_url) 
          VALUES ($1, $2, $3)
          ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname, avatar_url=excluded.avatar_url
        `, [userId, nickname, avatarUrl]);
      } else {
        db.prepare(`
          INSERT INTO users (id, nickname, avatar_url) 
          VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET nickname=excluded.nickname, avatar_url=excluded.avatar_url
        `).run(userId, nickname, avatarUrl);
      }
      
      io.to(roomId).emit("PROFILE_UPDATED", { userId, nickname, avatarUrl });
    });

    socket.on("MOVE_CURSOR", (data) => {
      const { roomId, userId, center } = data;
      socket.to(roomId).emit("USER_CURSOR_MOVED", { userId, center });
    });

    socket.on("CREATE_TRIP", async (data) => {
      const { roomId, title } = data;
      const id = `trip_${Date.now()}`;
      await execute(`INSERT INTO trips (id, room_id, title) VALUES (?, ?, ?)`, [id, roomId, title]);
      io.to(roomId).emit("TRIP_CREATED", { id, roomId, title });
    });

    socket.on("GET_PINS", async (tripId) => {
      const pins = await query(`SELECT * FROM pins WHERE trip_id = ?`, [tripId]);
      socket.emit("SYNC_PINS", pins);
    });

    socket.on("DRAW_ACTION", async (data) => {
      const { roomId, userId, type, payload } = data;
      const id = `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await execute(`
        INSERT INTO canvas_events (id, room_id, user_id, type, payload)
        VALUES (?, ?, ?, ?, ?)
      `, [id, roomId, userId, type, JSON.stringify(payload)]);

      io.to(roomId).emit("SYNC_ACTION", {
        actionId: id,
        userId,
        type,
        payload
      });
    });

    socket.on("UNDO_REQUEST", async (roomId) => {
      const lastEvent = await get(`
        SELECT * FROM canvas_events 
        WHERE room_id = ? AND is_undone = 0 
        ORDER BY created_at DESC LIMIT 1
      `, [roomId]);

      if (lastEvent) {
        await execute(`UPDATE canvas_events SET is_undone = 1 WHERE id = ?`, [lastEvent.id]);
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

    socket.on("VOTE_FINAL_RESULT", async (data) => {
      const { roomId, success, pinId, targetDay } = data;
      if (success) {
        await execute(`UPDATE pins SET assigned_day = ? WHERE id = ?`, [targetDay, pinId]);
      }
      io.to(roomId).emit("VOTE_RESULT_SYNC", { success, pinId, targetDay });
    });

    socket.on("SET_PIN_TIME", async (data) => {
      const { roomId, pinId, timeSlot, day } = data;
      await execute(`UPDATE pins SET time_slot = ?, assigned_day = ? WHERE id = ?`, [timeSlot, day, pinId]);
      io.to(roomId).emit("PIN_TIME_UPDATED", { pinId, timeSlot, day });
    });

    socket.on("SEND_MESSAGE", async (data) => {
      const { roomId, userId, content } = data;
      const id = `msg_${Date.now()}`;
      
      await execute(`
        INSERT INTO messages (id, room_id, sender_id, msg_type, content)
        VALUES (?, ?, ?, ?, ?)
      `, [id, roomId, userId, "text", content]);

      io.to(roomId).emit("SYNC_MESSAGE", {
        id,
        userId,
        content,
        createdAt: new Date().toISOString()
      });
    });

    socket.on("SET_AI_STATE", async (data) => {
      const { roomId, isThinking } = data;
      await execute(`UPDATE rooms SET ai_thinking = ? WHERE id = ?`, [isThinking ? 1 : 0, roomId]);
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
