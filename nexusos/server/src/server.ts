import express from 'express';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import cors from 'cors';
import Database from 'better-sqlite3';
import path from 'path';
import * as admin from 'firebase-admin';

dotenv.config();

// Initialize Firebase Admin
const serviceAccountPath = path.resolve(__dirname, '../../firebase-key.json');
try {
  const serviceAccount = require(serviceAccountPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin initialized successfully');
} catch (error) {
  console.error('Failed to initialize Firebase Admin:', (error as any).message);
}

const firestore = admin.apps.length > 0 ? admin.firestore() : null;

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Database connection
const dbPath = path.resolve(__dirname, process.env.DATABASE_PATH || '../../bot_database.db');
console.log('Database path:', dbPath);
const db = new Database(dbPath, { verbose: console.log });
db.pragma('journal_mode = WAL');

// Bot initialization
const token = process.env.TELEGRAM_BOT_TOKEN || '8598868295:AAHtIPKr7S0zqmjW7UhonZEwZREOvSQ1h0w';
const adminChatId = process.env.ADMIN_CHAT_ID;
const bot = new Telegraf(token);

// Global state for broadcast progress
let broadcastStatus = {
  active: false,
  total: 0,
  current: 0,
  success: 0,
  fail: 0,
  lastMessage: ''
};

// Activity Logs Helper
const logToAdmin = async (message: string) => {
  if (adminChatId) {
    try {
      await bot.telegram.sendMessage(adminChatId, `🔔 *LOG ADMIN*\n\n${message}`, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('Failed to send log to admin:', error);
    }
  }
};

// Firestore Sync Helper
const syncToFirestore = async (collection: string, docId: string, data: any) => {
  if (!firestore) return;
  try {
    // Remove null/undefined values
    const cleanData = Object.fromEntries(
      Object.entries(data).filter(([_, v]) => v != null)
    );
    
    // Add timestamp
    cleanData.last_synced = admin.firestore.FieldValue.serverTimestamp();
    
    await firestore.collection(collection).document(docId).set(cleanData, { merge: true });
    console.log(`[Firestore] Synced ${collection}/${docId}`);
  } catch (error) {
    console.error(`[Firestore] Sync failed for ${collection}/${docId}:`, (error as any).message);
  }
};

// 1. Health Check & Stats
app.get('/api/health', async (req, res) => {
  try {
    const botInfo = await bot.telegram.getMe();
    res.json({ status: 'Online', bot: botInfo.username });
  } catch (error) {
    res.status(500).json({ status: 'Offline', error: 'Bot API is not reachable' });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    const videoCount = db.prepare('SELECT COUNT(*) as count FROM videos').get() as { count: number };
    const pendingPaymentCount = db.prepare("SELECT COUNT(*) as count FROM payments WHERE status = 'PENDING'").get() as { count: number };
    const vipCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE vip_until > datetime('now')").get() as { count: number };

    res.json({
      users: userCount.count,
      videos: videoCount.count,
      pendingPayments: pendingPaymentCount.count,
      activeVip: vipCount.count
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/broadcast/status', (req, res) => {
  res.json(broadcastStatus);
});

app.get('/api/broadcasts', (req, res) => {
  try {
    const broadcasts = db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 50').all();
    res.json(broadcasts);
  } catch (error) {
    console.error('Broadcast history error:', error);
    res.status(500).json({ error: 'Failed to fetch broadcast history' });
  }
});

// 2. Broadcast API
app.post('/api/broadcast', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (broadcastStatus.active) return res.status(400).json({ error: 'Broadcast already in progress' });

  try {
    const users = db.prepare('SELECT user_id FROM users').all() as { user_id: number }[];
    
    // Initialize status
    broadcastStatus = {
      active: true,
      total: users.length,
      current: 0,
      success: 0,
      fail: 0,
      lastMessage: message
    };

    // Run broadcast in background
    (async () => {
      for (const user of users) {
        if (!broadcastStatus.active) break; // Allow stopping if needed

        try {
          await bot.telegram.sendMessage(user.user_id, message, { parse_mode: 'HTML' });
          broadcastStatus.success++;
        } catch (err) {
          console.error(`Broadcast failed for ${user.user_id}:`, (err as any).message);
          broadcastStatus.fail++;
        }
        
        broadcastStatus.current++;
        
        // Rate limiting
        if (broadcastStatus.current % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      const summary = `Broadcast Selesai!\nTotal: ${broadcastStatus.total}\nSukses: ${broadcastStatus.success}\nGagal: ${broadcastStatus.fail}`;
      await logToAdmin(summary);
      broadcastStatus.active = false;
    })();

    res.json({ success: true, message: 'Broadcast started in background' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start broadcast' });
  }
});

app.post('/api/broadcast/stop', (req, res) => {
  broadcastStatus.active = false;
  res.json({ success: true, message: 'Broadcast stopping...' });
});

// 3. User Management APIs
app.get('/api/users', (req, res) => {
  try {
    const { search } = req.query;
    let users;
    if (search) {
      const query = `%${search}%`;
      users = db.prepare('SELECT * FROM users WHERE user_id LIKE ? OR username LIKE ? OR first_name LIKE ? ORDER BY joined_at DESC').all(query, query, query);
    } else {
      users = db.prepare('SELECT * FROM users ORDER BY joined_at DESC LIMIT 100').all();
    }
    res.json(users);
  } catch (error) {
    console.error('Users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/users/vip', async (req, res) => {
  const { userId, days } = req.body;
  try {
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + days);
    const expiryStr = expiryDate.toISOString().replace('T', ' ').substring(0, 19);

    db.prepare('UPDATE users SET vip_until = ? WHERE user_id = ?').run(expiryStr, userId);
    
    await bot.telegram.sendMessage(userId, `🎉 *Selamat!* Akun Anda telah ditingkatkan ke VIP selama ${days} hari.\nBerlaku hingga: ${expiryStr}`, { parse_mode: 'Markdown' });
    await logToAdmin(`User ${userId} ditambahkan VIP (${days} hari).`);
    
    // [FIREBASE SYNC]
    await syncToFirestore('users', userId.toString(), {
      user_id: userId,
      vip_until: expiryStr,
      last_updated: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update VIP status' });
  }
});

app.post('/api/users/ban', async (req, res) => {
  const { userId } = req.body;
  try {
    // In this bot, "ban" might just be removing admin status or setting a flag
    // We'll update a column if it exists or just log it for now
    db.prepare('UPDATE users SET is_admin = 0 WHERE user_id = ?').run(userId);
    
    await bot.telegram.sendMessage(userId, `⚠️ Akses Anda ke bot ini telah dibatasi oleh admin.`);
    await logToAdmin(`User ${userId} telah di-ban/dibatasi.`);
    
    // [FIREBASE SYNC]
    await syncToFirestore('users', userId.toString(), {
      is_admin: 0,
      status: 'BANNED'
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

app.get('/api/payments/pending', (req, res) => {
  try {
    const payments = db.prepare("SELECT p.*, u.username FROM payments p JOIN users u ON p.user_id = u.user_id WHERE p.status = 'PENDING'").all();
    res.json(payments);
  } catch (error) {
    console.error('Pending payments error:', error);
    res.status(500).json({ error: 'Failed to fetch pending payments' });
  }
});

app.get('/api/payments/history', (req, res) => {
  try {
    const payments = db.prepare(`
      SELECT p.*, u.username, u.first_name 
      FROM payments p 
      JOIN users u ON p.user_id = u.user_id 
      WHERE p.status = 'APPROVED' 
      ORDER BY p.approved_at DESC 
      LIMIT 50
    `).all();
    res.json(payments);
  } catch (error) {
    console.error('Payment history error:', error);
    res.status(500).json({ error: 'Failed to fetch payment history' });
  }
});

app.post('/api/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  try {
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get() as any;
    if (!payment) return res.status(404).json({ error: 'Payment not found' });

    db.prepare("UPDATE payments SET status = 'APPROVED', approved_at = CURRENT_TIMESTAMP WHERE id = ?").run(paymentId);
    
    // Update user VIP
    const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get() as any;
    const currentVip = user.vip_until ? new Date(user.vip_until) : new Date();
    if (currentVip < new Date()) currentVip.setTime(new Date().getTime());
    currentVip.setDate(currentVip.getDate() + payment.days);
    const expiryStr = currentVip.toISOString().replace('T', ' ').substring(0, 19);
    
    db.prepare('UPDATE users SET vip_until = ? WHERE user_id = ?').run(expiryStr, payment.user_id);

    await bot.telegram.sendMessage(payment.user_id, `✅ *Pembayaran Disetujui!*\nTerima kasih, paket VIP Anda telah aktif hingga ${expiryStr}.`, { parse_mode: 'Markdown' });
    await logToAdmin(`Pembayaran #${paymentId} dari User ${payment.user_id} telah DISETUJUI.`);

    // [FIREBASE SYNC]
    await syncToFirestore('payments', paymentId.toString(), {
      status: 'APPROVED',
      approved_at: admin.firestore.FieldValue.serverTimestamp()
    });
    
    await syncToFirestore('users', payment.user_id.toString(), {
      vip_until: expiryStr
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve payment' });
  }
});

// --- BiliTV API Proxy ---
const bilitvBase = process.env.BILITV_BASE_URL || 'https://bilitv.dramabos.my.id/api';
const bilitvToken = process.env.BILITV_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

// VIP status check for Stellar Streaming
app.get('/api/bilitv/vip-check/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const user = db.prepare("SELECT vip_until FROM users WHERE user_id = ?").get(userId) as any;
    if (user && user.vip_until && new Date(user.vip_until) > new Date()) {
      res.json({ isVip: true, vipUntil: user.vip_until });
    } else {
      res.json({ isVip: false, vipUntil: null });
    }
  } catch (error) {
    res.json({ isVip: false, vipUntil: null });
  }
});

app.get('/api/bilitv/home', async (req, res) => {
  try {
    const { page = 1, limit = 20, lang = 'id' } = req.query;
    const response = await axios.get(`${bilitvBase}/home`, {
      params: { page, limit, lang }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Home failed' });
  }
});

app.get('/api/bilitv/search', async (req, res) => {
  try {
    const { q, lang = 'id' } = req.query;
    const response = await axios.get(`${bilitvBase}/search`, {
      params: { q, lang }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Search failed' });
  }
});

app.get('/api/bilitv/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${bilitvBase}/short/${id}`, {
      params: { lang }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Detail failed' });
  }
});

app.get('/api/bilitv/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`${bilitvBase}/short/${id}/episode`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Episodes failed' });
  }
});

app.get('/api/bilitv/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = 720, lang = 'id' } = req.query;
    const response = await axios.get(`${bilitvBase}/stream/${id}/${ep}`, {
      params: { quality, lang, code: bilitvToken }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Stream failed' });
  }
});

app.get('/api/bilitv/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id', format = 'json' } = req.query;
    const response = await axios.get(`${bilitvBase}/subtitle/${id}/${ep}`, {
      params: { lang, format, code: bilitvToken }
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'BiliTV Subtitle failed' });
  }
});

// 5. Listener for payments (Incoming files/messages)
bot.on('message', async (ctx) => {
  const user = ctx.from;
  console.log(`Incoming message from ${user.id} (${user.username})`);

  let fileId: string | undefined;
  if ('photo' in ctx.message) {
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    console.log('Detected photo:', fileId);
  } else if ('document' in ctx.message) {
    fileId = ctx.message.document.file_id;
    console.log('Detected document:', fileId);
  }

  if (fileId) {
    try {
      db.prepare("INSERT INTO payments (user_id, amount, days, status, proof_file_id) VALUES (?, ?, ?, 'PENDING', ?)").run(
        user.id, 0, 0, fileId
      );
      console.log(`Payment proof saved for user ${user.id}`);
      await ctx.reply('📩 Bukti pembayaran telah diterima dan sedang menunggu verifikasi admin.');
      await logToAdmin(`Bukti pembayaran baru dari ${user.username || user.id} (File ID: ${fileId})`);
      
      // [FIREBASE SYNC]
      // Note: We don't have the auto-increment ID yet, but we can query it or use a separate sync
      // For now, let's just sync the user status
      await syncToFirestore('users', user.id.toString(), {
        user_id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_activity: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Failed to save payment:', error);
    }
  }
});

// Start bot and server
bot.launch().catch(err => {
  console.error('Failed to launch bot (likely 409 Conflict):', err.message);
  console.log('Web server will continue to run without real-time bot listeners.');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
