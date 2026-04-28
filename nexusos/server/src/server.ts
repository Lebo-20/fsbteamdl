import express from 'express';
import { exec } from 'child_process';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import cors from 'cors';
// Triggering reload for Reelala token integration
import Database from 'better-sqlite3';
import path from 'path';
import * as admin from 'firebase-admin';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import http from 'http';
import https from 'https';

dotenv.config();

// Initialize Firebase Admin
const serviceAccountPath = path.resolve(__dirname, '../../../firebase-key.json');
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

// Global Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Database connection
const dbPath = path.resolve(__dirname, process.env.DATABASE_PATH || '../../bot_database.db');
console.log('Database path:', dbPath);
const db = new Database(dbPath, { verbose: console.log });
db.pragma('journal_mode = WAL');

// Initialize settings table
db.prepare(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`).run();

// Seed default settings if not exists
const seedSettings = [
  { key: 'maintenance_mode', value: 'off' },
  { key: 'hide_home', value: 'off' },
  { key: 'hide_discover', value: 'off' },
  { key: 'hide_search', value: 'off' },
  { key: 'show_demo', value: 'off' },
  { key: 'platform_bilitv', value: 'on' },
  { key: 'platform_moboreels', value: 'on' },
  { key: 'platform_reelala', value: 'on' },
  { key: 'platform_reelshort', value: 'on' },
  { key: 'platform_dramabox', value: 'on' },
  { key: 'platform_dramapops', value: 'on' },
  { key: 'platform_shortmax', value: 'on' },
  { key: 'platform_flextv', value: 'on' },
  { key: 'platform_dramabite', value: 'on' },
  { key: 'platform_idrama', value: 'on' },
  { key: 'platform_goodshort', value: 'on' },
  { key: 'platform_shortbox', value: 'on' },
  { key: 'platform_dramawave', value: 'on' },
  { key: 'platform_shortswave', value: 'on' },
  { key: 'platform_velolo', value: 'on' },
  { key: 'platform_happyshort', value: 'on' },
  { key: 'platform_rapidtv', value: 'on' },
  { key: 'default_subtitle_lang', value: 'id' }
];

const insertSetting = db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)");
seedSettings.forEach(s => insertSetting.run(s.key, s.value));

// App Settings Helper
const getAppSetting = (key: string, defaultValue: string = 'off') => {
  try {
    const s = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string };
    return s ? s.value : defaultValue;
  } catch {
    return defaultValue;
  }
};

// Set global axios timeout
axios.defaults.timeout = 10000;

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

// Cache System
const apiCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_CLEAR_INTERVAL = 2 * 60 * 60 * 1000; // 2 Hours

const clearAllCache = () => {
  const cacheCount = apiCache.size;
  apiCache.clear();
  
  // Also clear log file if it exists
  const logPath = path.resolve(__dirname, '../server_log.txt');
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] Cache & Log auto-cleared.\n`);
  }
  
  console.log(`[Cache System] Auto-clear executed. Cleared ${cacheCount} items and rotated logs.`);
};

// Set interval for auto-clear every 2 hours
setInterval(clearAllCache, CACHE_CLEAR_INTERVAL);

// Cache Helpers
const getCache = (key: string) => {
  const item = apiCache.get(key);
  if (item) return item.data;
  return null;
};

const setCache = (key: string, data: any) => {
  apiCache.set(key, { data, timestamp: Date.now() });
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
    
    await firestore.collection(collection).doc(docId).set(cleanData, { merge: true });
    console.log(`[Firestore] Synced ${collection}/${docId}`);
  } catch (error) {
    console.error(`[Firestore] Sync failed for ${collection}/${docId}:`, (error as any).message);
  }
};

// Outgoing Proxy Helper
const getProxy = () => {
  try {
    const proxyPath = path.resolve(__dirname, '../../../proxies.txt');
    if (fs.existsSync(proxyPath)) {
      const content = fs.readFileSync(proxyPath, 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      if (lines.length > 0) {
        const randomProxy = lines[Math.floor(Math.random() * lines.length)];
        const parts = randomProxy.split(':');
        if (parts.length === 4) {
          const [ip, port, user, pass] = parts;
          return `http://${user}:${pass}@${ip}:${port}`;
        } else if (parts.length === 2) {
          const [ip, port] = parts;
          return `http://${ip}:${port}`;
        }
      }
    }
  } catch (err) {
    console.error('Failed to read proxy file:', (err as any).message);
  }
  return null;
};

// Keep-alive agents for better performance and stealth
const keepAliveHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
const keepAliveHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 100, rejectUnauthorized: false });

// Subtitle Parsing Helpers
const parseTime = (timeStr: string) => {
  if (!timeStr) return 0;
  const parts = timeStr.trim().replace(',', '.').split(':');
  let sec = 0;
  if (parts.length === 3) {
    sec = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    sec = parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  } else {
    sec = parseFloat(parts[0]);
  }
  return isNaN(sec) ? 0 : sec;
};

const parseVTT = (vtt: string) => {
  const lines = vtt.split(/\r?\n/);
  const subs: { from: number; to: number; content: string }[] = [];
  let currentSub: any = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const parts = line.split('-->');
      const start = parseTime(parts[0].trim());
      const end = parseTime(parts[1].trim());
      currentSub = { from: start, to: end, content: '' };
    } else if (currentSub && line !== '' && !line.match(/^\d+$/) && line !== 'WEBVTT' && !line.startsWith('NOTE')) {
      // Remove VTT tags like <v ...> or <b>
      const cleaned = line.replace(/<[^>]*>/g, '').replace(/\[.*?\]/g, '').replace(/->/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      if (cleaned) currentSub.content += (currentSub.content ? '\n' : '') + cleaned;
    } else if (line === '' && currentSub) {
      if (currentSub.content) subs.push(currentSub);
      currentSub = null;
    }
  }
  if (currentSub && currentSub.content) subs.push(currentSub);
  return subs;
};

const parseSRT = (srt: string) => {
  const lines = srt.split(/\r?\n/);
  const subs: { from: number; to: number; content: string }[] = [];
  let currentSub: any = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.match(/^\d+$/)) {
      if (currentSub && currentSub.content) subs.push(currentSub);
      currentSub = { from: 0, to: 0, content: '' };
    } else if (line.includes('-->')) {
      const parts = line.split('-->');
      const start = parseTime(parts[0].trim());
      const end = parseTime(parts[1].trim());
      if (!currentSub) currentSub = { from: start, to: end, content: '' };
      else {
        currentSub.from = start;
        currentSub.to = end;
      }
    } else if (currentSub && line !== '') {
      const cleaned = line.replace(/<[^>]*>/g, '').replace(/\[.*?\]/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
      if (cleaned) currentSub.content += (currentSub.content ? '\n' : '') + cleaned;
    } else if (line === '' && currentSub) {
      if (currentSub.content) subs.push(currentSub);
      currentSub = null;
    }
  }
  if (currentSub && currentSub.content) subs.push(currentSub);
  return subs;
};

const parseASS = (ass: string) => {
  const lines = ass.split(/\r?\n/);
  const subs: { from: number; to: number; content: string }[] = [];
  
  for (let line of lines) {
    if (line.startsWith('Dialogue:')) {
      const parts = line.split(',');
      if (parts.length >= 10) {
        const start = parseTime(parts[1].trim());
        const end = parseTime(parts[2].trim());
        // Everything after the 9th comma is the text
        const textParts = parts.slice(9).join(',');
        // Remove ASS tags and HTML entities
        const cleaned = textParts.replace(/\{.*?\}/g, '')
          .replace(/\\N/g, '\n')
          .replace(/&nbsp;/g, ' ')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
        if (cleaned) subs.push({ from: start, to: end, content: cleaned });
      }
    }
  }
  return subs;
};

const standardizeSubtitles = async (input: any): Promise<{ from: number; to: number; content: string }[]> => {
  try {
    let list: any[] = [];
    if (Array.isArray(input)) {
      list = input;
    } else {
      let data = input;
      if (typeof input === 'string' && input.startsWith('http')) {
        const response = await axios.get(input, {
          timeout: 15000,
          headers: { 
            'User-Agent': 'Mozilla/5.0',
            'Referer': 'https://shortswave.com/',
            'Origin': 'https://shortswave.com'
          }
        });
        data = response.data;
      }

      if (typeof data !== 'string') {
        if (Array.isArray(data)) {
          list = data.map((item: any) => ({
            from: item.from || item.start || item.startTime || 0,
            to: item.to || item.end || item.endTime || 0,
            content: item.content || item.text || item.words || ''
          }));
        }
      } else if (data.includes('WEBVTT') || data.includes('X-TIMESTAMP-MAP')) {
        list = parseVTT(data);
      } else if (data.includes('-->')) {
        list = parseSRT(data);
      } else if (data.startsWith('[Script Info]') || data.includes('Dialogue:')) {
        list = parseASS(data);
      }
    }

    return list;
  } catch (error) {
    console.error(`[Subtitle Standardization] Failed for input:`, (error as any).message);
    return [];
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

// --- MoboReels API Proxy ---
const moboBase = process.env.MOBOREELS_BASE_URL || 'https://captain.sapimu.au/moboreels';
const moboToken = process.env.MOBOREELS_TOKEN || '';
const moboHeaders = () => ({ 
  Authorization: `Bearer ${moboToken}`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.cdreader.com/'
});

// --- Reelala API Proxy ---
const reelalaBase = process.env.REELALA_BASE_URL || 'https://captain.sapimu.au/reelala';
const reelalaToken = process.env.REELALA_TOKEN || '';
const reelalaHeaders = () => ({ 
  Authorization: `Bearer ${reelalaToken}`,
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://captain.sapimu.au/'
});

// MoboReels: Home (Hot/Trending list)
app.get('/api/moboreels/home', async (req, res) => {
  try {
    const pageNum = Number(req.query.page) || 1;
    const limitNum = Number(req.query.limit) || 20;
    const langId = '11';
    
    // Use many more list IDs and offset them by page
    const listIds = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    const fetchCount = limitNum > 30 ? 3 : 1; 
    const startIdx = ((pageNum - 1) * fetchCount) % listIds.length;
    
    const requests = listIds.slice(startIdx, startIdx + fetchCount).map(id => 
      axios.get(`${moboBase}/api/hotList`, {
        params: { listId: id, langId },
        headers: moboHeaders()
      })
    );
    
    const responses = await Promise.allSettled(requests);
    const merged: any[] = [];
    responses.forEach(r => {
      if (r.status === 'fulfilled') {
        const items = r.value.data?.data?.series || [];
        merged.push(...items);
      }
    });

    const mapped = merged.map((d: any) => ({
      id: d.seriesId,
      title: d.seriesName,
      poster: d.coverUrl,
      episodes: d.totalEpisodes || 0,
      likes: d.score ? String(d.score) : '0',
      isVip: false,
      platform: 'MOBOREELS'
    }));
    
    res.json({ data: { dramas: mapped }, platform: 'MOBOREELS' });
  } catch (error: any) {
    console.error('MoboReels Home error:', error.response?.data || error.message || error);
    res.status(500).json({ error: 'MoboReels Home failed', details: error.message });
  }
});

// MoboReels: Search (via hotList + keyword filter)
app.get('/api/moboreels/search', async (req, res) => {
  try {
    const { q = '' } = req.query;
    const langId = '11';
    const [trending, latest] = await Promise.all([
      axios.get(`${moboBase}/api/hotList`, { params: { listId: 10, langId }, headers: moboHeaders() }),
      axios.get(`${moboBase}/api/hotList`, { params: { listId: 11, langId }, headers: moboHeaders() })
    ]);
    const all = [
      ...(trending.data?.data?.series || []),
      ...(latest.data?.data?.series || [])
    ];
    const keyword = String(q).toLowerCase();
    const filtered = keyword
      ? all.filter((d: any) => (d.seriesName || '').toLowerCase().includes(keyword))
      : all;
    const mapped = filtered.map((d: any) => ({
      id: d.seriesId,
      title: d.seriesName,
      poster: d.coverUrl,
      episodes: d.totalEpisodes || 0,
      likes: d.score ? String(d.score) : '0',
      isVip: false,
      platform: 'MOBOREELS'
    }));
    res.json({ data: { dramas: mapped }, platform: 'MOBOREELS' });
  } catch (error: any) {
    console.error('MoboReels Search error:', error.message);
    res.status(500).json({ error: 'MoboReels Search failed' });
  }
});

// MoboReels: Detail
app.get('/api/moboreels/detail/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = '11' } = req.query;
    const langId = lang === 'id' ? '11' : lang;
    const response = await axios.get(`${moboBase}/api/seriesDetail`, {
      params: { seriesId: id, langId },
      headers: moboHeaders()
    });
    res.json(response.data);
  } catch (error: any) {
    res.status(500).json({ error: 'MoboReels Detail failed' });
  }
});

// MoboReels: Episodes list (returns flat list like BiliTV)
app.get('/api/moboreels/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = '11' } = req.query;
    const langId = lang === 'id' ? '11' : lang;
    const response = await axios.get(`${moboBase}/api/seriesPage`, {
      params: { seriesId: id, pageNo: 1, pageSize: 200, langId },
      headers: moboHeaders()
    });
    const epList = response.data?.data?.episodeVos || response.data?.data?.items || [];
    const mapped = epList.map((ep: any) => ({
      id: String(ep.episNum), // Use episNum as ID for stream route consistency
      episId: ep.episId,
      title: ep.name || `Episode ${ep.episNum}`,
      episNum: ep.episNum,
      cover: ep.cover || '',
      isVip: ep.isFree === 0 || ep.price > 0
    }));
    res.json({ data: { list: mapped }, platform: 'MOBOREELS' });
  } catch (error: any) {
    res.status(500).json({ error: 'MoboReels Episodes failed' });
  }
});

// MoboReels: Stream URL (quality param forwarded but MoboReels auto-unlocks)
// --- Reelala Routes ---
app.get('/api/reelala/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const pg = Number(page);
    // Use for-you endpoint which supports pagination
    const response = await axios.get(`${reelalaBase}/api/for-you`, {
      params: { lang, page: pg },
      headers: reelalaHeaders()
    });
    let rawList = response.data?.data?.list || response.data?.data || [];
    if (!Array.isArray(rawList)) rawList = [];

    // If for-you is empty, fall back to home
    if (rawList.length === 0) {
      const homeRes = await axios.get(`${reelalaBase}/api/home`, {
        params: { lang },
        headers: reelalaHeaders()
      });
      const rawCategories = homeRes.data?.data || [];
      if (Array.isArray(rawCategories)) {
        rawCategories.forEach((cat: any) => {
          const items = cat.list || [];
          if (Array.isArray(items)) {
            items.forEach((d: any) => rawList.push(d));
          }
        });
      }
    }
    
    const allDramas: any[] = Array.isArray(rawList) ? rawList.map((d: any) => ({
      id: d.playlet_id || d.id,
      title: d.playlet_title || d.title || d.name || '',
      poster: d.cover || d.cover_url || d.poster || '',
      episodes: parseInt(d.chapter_num) || parseInt(d.upload_num) || parseInt(d.episodes) || 0,
      likes: d.hot_num || d.score || '0',
      platform: 'REELALA'
    })) : [];
    
    const unique = allDramas.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
    res.json({ data: { dramas: unique }, platform: 'REELALA' });
  } catch (error: any) {
    console.error('Reelala Home error:', error.message);
    res.json({ data: { dramas: [] }, platform: 'REELALA' });
  }
});

app.get('/api/reelala/search', async (req, res) => {
  try {
    const { q = '', lang = 'id' } = req.query;
    const response = await axios.get(`${reelalaBase}/api/search`, {
      params: { keyword: q, lang },
      headers: reelalaHeaders()
    });
    const rawList = response.data?.data?.list || response.data?.data || [];
    const mapped = Array.isArray(rawList) ? rawList.map((d: any) => ({
      id: d.playlet_id || d.id,
      title: d.playlet_title || d.title || d.name || '',
      poster: d.cover || d.cover_url || d.poster || '',
      episodes: parseInt(d.chapter_num) || parseInt(d.upload_num) || parseInt(d.episodes) || 0,
      likes: d.hot_num || d.score || '0',
      platform: 'REELALA'
    })) : [];
    res.json({ dramas: mapped, platform: 'REELALA' });
  } catch (error: any) {
    console.error('Reelala Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/reelala/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${reelalaBase}/api/chapters`, {
      params: { playlet_id: id, lang },
      headers: reelalaHeaders()
    });
    const rawList = response.data?.data?.list || response.data?.data || [];
    const serverHost = req.headers.host || '127.0.0.1:5001';
    const mapped = rawList.map((ep: any) => {
      const rawUrl = ep.hls_url || ep.video_url || ep.streamUrl || ep.stream_url || ep.url || '';
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = rawUrl 
        ? `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(rawUrl)}&platform=REELALA`
        : '';
      return {
        id: ep.chapter_id || ep.id,
        title: ep.chapter_title || ep.title || `EP ${ep.chapter_num}`,
        episNum: ep.chapter_num || ep.episNum,
        streamUrl: proxiedUrl,
        isVip: ep.is_vip || ep.isVip || false
      };
    });
    res.json({ data: { list: mapped }, platform: 'REELALA' });
  } catch (error: any) {
    console.error('Reelala Chapters error:', error.message);
    res.json({ data: { list: [] }, platform: 'REELALA' });
  }
});

app.get('/api/reelala/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${reelalaBase}/api/chapters`, {
      params: { playlet_id: id, lang },
      headers: reelalaHeaders()
    });
    const list = response.data?.data?.list || response.data?.data || [];
    const epNum = parseInt(ep);
    
    // Match by chapter_num (ep number) OR by id/chapter_id
    const match = list.find((i: any) => 
      i.chapter_num === epNum || 
      String(i.chapter_id) === String(ep) || 
      String(i.id) === String(ep)
    );
    
    const rawUrl = match?.hls_url || match?.video_url || match?.stream_url || match?.streamUrl || match?.url || '';
    
    if (rawUrl) {
      const serverHost = req.headers.host || '127.0.0.1:5001';
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(rawUrl)}&platform=REELALA`;
      console.log(`[Reelala] Stream EP${epNum}:`, rawUrl.substring(0, 60) + '...');
      res.json({ data: { url: proxiedUrl }, platform: 'REELALA' });
    } else {
      console.warn(`[Reelala] No URL for ID=${id} EP=${ep}. Fields:`, match ? Object.keys(match) : 'not found');
      res.json({ data: { url: '' }, error: 'Episode not found or no URL', platform: 'REELALA' });
    }
  } catch (error: any) {
    console.error('Reelala Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'REELALA' });
  }
});

const reelshortBase = process.env.REELSHORT_BASE_URL;
const reelshortToken = process.env.REELSHORT_TOKEN;

app.get('/api/reelshort/home', async (req, res) => {
  try {
    const { lang = 'in', page = 1 } = req.query;
    // Rotate through different feed tabs per page for variety
    const tabIds = [44421, 44422, 44423, 44424, 44425, 44426]; // popular, foryou, new, romance, drama, completed
    const tabId = tabIds[(Number(page) - 1) % tabIds.length];
    const response = await axios.get(`${reelshortBase}/api/v1/feed/${tabId}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${reelshortToken}` }
    });
    const shelves = response.data?.data?.lists || [];
    const allBooks = shelves.flatMap((s: any) => s.books || []);
    res.json({ data: allBooks, platform: 'REELSHORT' });
  } catch (error: any) {
    console.error('ReelShort Home error:', error.message);
    res.status(500).json({ error: 'ReelShort Home failed' });
  }
});

app.get('/api/reelshort/search', async (req, res) => {
  try {
    const { keyword, lang = 'in', page = 1 } = req.query;
    const response = await axios.get(`${reelshortBase}/api/v1/search`, {
      params: { q: keyword, lang, page },
      headers: { Authorization: `Bearer ${reelshortToken}` }
    });
    const list = response.data?.data?.lists || [];
    res.json({ data: list, platform: 'REELSHORT' });
  } catch (error: any) {
    console.error('ReelShort Search error:', error.message);
    res.status(500).json({ error: 'ReelShort Search failed' });
  }
});

app.get('/api/reelshort/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'in' } = req.query;
    const response = await axios.get(`${reelshortBase}/api/v1/book/${id}/chapters`, {
      params: { lang },
      headers: { Authorization: `Bearer ${reelshortToken}` }
    });
    const chapters = response.data?.data?.chapters || [];
    res.json({ data: chapters, platform: 'REELSHORT' });
  } catch (error: any) {
    console.error('ReelShort Episodes error:', error.message);
    res.status(500).json({ error: 'ReelShort Episodes failed' });
  }
});

app.get('/api/reelshort/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const epNum = parseInt(ep);
    
    // Get chapters to find ID for this number
    const resC = await axios.get(`${reelshortBase}/api/v1/book/${id}/chapters`, {
      headers: { Authorization: `Bearer ${reelshortToken}` }
    });
    const chapters = resC.data?.data?.chapters || [];
    const match = chapters.find((c: any) => c.serial_number === epNum) || chapters[epNum - 1];
    
    if (match) {
      const chapterId = match.chapter_id;
      const response = await axios.get(`${reelshortBase}/api/v1/book/${id}/chapter/${chapterId}/video`, {
        headers: { Authorization: `Bearer ${reelshortToken}` }
      });
      
      const videos = response.data?.data?.videos || [];
      const bestVideo = videos.find((v: any) => v.Dpi === 720) || videos[0];
      
      if (bestVideo && bestVideo.PlayURL) {
        const serverHost = req.headers.host || '127.0.0.1:5001';
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(bestVideo.PlayURL)}`;
        res.json({ data: { url: proxiedUrl }, platform: 'REELSHORT' });
      } else {
        res.json({ data: { url: '' }, error: 'No video URL found' });
      }
    } else {
      res.json({ data: { url: '' }, error: 'Episode not found' });
    }
  } catch (error: any) {
    console.error('ReelShort Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'REELSHORT' });
  }
});

const dramaboxBase = process.env.DRAMABOX_BASE_URL;
const dramaboxToken = process.env.DRAMABOX_TOKEN;

app.get('/api/dramabox/home', async (req, res) => {
  const cacheKey = `dramabox_home_${req.query.page}_${req.query.lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    let { lang = 'in', page = 1 } = req.query;
    if (lang === 'id') lang = 'in';
    const pg = Number(page);
    let list: any[] = [];
    
    // Use theater channels per page for variety
    const channelIds = [205, 206, 207, 208, 209, 210, 211, 212];
    const channelId = channelIds[(pg - 1) % channelIds.length];
    try {
      const theaterRes = await axios.get(`${dramaboxBase}/api/theater`, {
        params: { channelId, lang },
        headers: { Authorization: `Bearer ${dramaboxToken}` }
      });
      const theaterData = theaterRes.data?.data?.data || theaterRes.data?.data || {};
      // Correct path: columnVoList[].bookList
      const columns = theaterData?.columnVoList || [];
      if (Array.isArray(columns) && columns.length > 0) {
        list = columns.flatMap((col: any) => col.bookList || []);
      }
    } catch {}
    
    // Fallback to rank endpoint
    if (!list.length) {
      const rankRes = await axios.get(`${dramaboxBase}/api/rank`, {
        params: { lang },
        headers: { Authorization: `Bearer ${dramaboxToken}` }
      });
      list = rankRes.data?.data?.data?.rankList || rankRes.data?.data?.rankList || [];
    }
    
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap || d.cover,
      episodes: d.chapterCount || d.totalChapter || 0,
      likes: d.rankVo?.hotCode || d.hotCode || '0',
      platform: 'DRAMABOX'
    })).filter((d: any) => d.id && d.title);
    
    const result = { dramas: mapped, platform: 'DRAMABOX' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('DramaBox Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramabox/search', async (req, res) => {
  const cacheKey = `dramabox_search_${req.query.keyword}_${req.query.lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    let { keyword, lang = 'in', page = 1 } = req.query;
    if (lang === 'id') lang = 'in';
    const response = await axios.get(`${dramaboxBase}/api/search`, {
      params: { keyword, lang, page },
      headers: { Authorization: `Bearer ${dramaboxToken}` }
    });
    const list = response.data?.data?.data?.searchList || response.data?.data?.searchList || [];
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap,
      episodes: d.chapterCount,
      likes: d.hotCode || '0',
      platform: 'DRAMABOX'
    }));
    const result = { dramas: mapped, platform: 'DRAMABOX' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('DramaBox Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramabox/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { lang = 'in' } = req.query;
    if (lang === 'id') lang = 'in';
    const response = await axios.get(`${dramaboxBase}/api/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramaboxToken}` }
    });
    const list = response.data?.data?.data?.list || response.data?.data?.list || [];
    const serverHost = req.headers.host || '127.0.0.1:5001';
    const mapped = list.map((ep: any) => {
      const epIndex = ep.chapterIndex + 1;
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(
        `${dramaboxBase}/api/drama/${id}/stream?episode=${epIndex}&quality=1080`
      )}&platform=DRAMABOX`;
      // We'll build streamUrl on demand via /stream route instead
      return {
        id: ep.chapterId,
        title: `Episode ${epIndex}`,
        episNum: epIndex,
        chapterId: ep.chapterId,
        isVip: ep.isCharge === 1
      };
    });
    res.json({ data: { list: mapped }, platform: 'DRAMABOX' });
  } catch (error: any) {
    console.error('DramaBox Detail error:', error.message);
    res.json({ data: { list: [] }, platform: 'DRAMABOX' });
  }
});

app.get('/api/dramabox/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = '1080' } = req.query;
    let epNum = parseInt(ep);

    // If ep looks like a chapterId (large number > 10000), resolve to episode index
    if (epNum > 10000) {
      try {
        const detailRes = await axios.get(`${dramaboxBase}/api/drama/${id}`, {
          params: { lang: 'in' },
          headers: { Authorization: `Bearer ${dramaboxToken}` }
        });
        const list = detailRes.data?.data?.data?.list || detailRes.data?.data?.list || [];
        const found = list.find((i: any) => String(i.chapterId) === String(ep));
        if (found) epNum = found.chapterIndex + 1;
        else epNum = 1; // fallback
        console.log(`[DramaBox] Resolved chapterId ${ep} -> episode ${epNum}`);
      } catch (e) {
        epNum = 1;
      }
    }

    const response = await axios.get(`${dramaboxBase}/api/drama/${id}/episodes`, {
      params: { quality },
      headers: { Authorization: `Bearer ${dramaboxToken}` }
    });
    // Correct path: data.data.episodes[]
    const list = response.data?.data?.episodes || [];
    const match = list.find((i: any) => i.episode === epNum) || list[epNum - 1];
    const videoUrl = match?.url || match?.videoUrl || match?.stream_url || '';
    if (videoUrl) {
      const serverHost = req.headers.host || '127.0.0.1:5001';
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(videoUrl)}&platform=DRAMABOX`;
      console.log(`[DramaBox] Stream EP${epNum}:`, videoUrl.substring(0, 60) + '...');
      res.json({ data: { url: proxiedUrl }, platform: 'DRAMABOX' });
    } else {
      console.warn(`[DramaBox] No URL for ID=${id} EP=${ep}(=${epNum}). Fields:`, match ? Object.keys(match) : 'not found');
      res.json({ data: { url: '' }, error: 'Episode not found', platform: 'DRAMABOX' });
    }
  } catch (error: any) {
    console.error('DramaBox Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'DRAMABOX' });
  }
});

app.get('/api/dramabox/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const epNum = parseInt(ep);
    let { lang = 'in' } = req.query;
    if (lang === 'id') lang = 'in';
    const response = await axios.get(`${dramaboxBase}/api/drama/${id}/episodes`, {
      headers: { Authorization: `Bearer ${dramaboxToken}` }
    });
    const list = response.data?.data?.episodes || [];
    const match = list.find((i: any) => i.episode === epNum) || list[epNum - 1];
    if (match && match.subtitles) {
      const sub = match.subtitles.find((s: any) => s.lang === lang) 
               || match.subtitles.find((s: any) => s.lang === 'en') 
               || match.subtitles[0];
      if (sub && sub.url) {
        const list = await standardizeSubtitles(sub.url);
        return res.json({ data: { list }, platform: 'DRAMABOX' });
      }
    }
    res.json({ data: { list: [] }, platform: 'DRAMABOX' });
  } catch (error) {
    res.json({ data: { list: [] }, platform: 'DRAMABOX' });
  }
});

// --- ShortMax Routes ---
const shortmaxBase = process.env.SHORTMAX_BASE_URL;
const shortmaxToken = process.env.SHORTMAX_TOKEN;

app.get('/api/shortmax/home', async (req, res) => {
  const cacheKey = `shortmax_home_${req.query.page}_${req.query.lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { lang = 'id', page = 1 } = req.query;
    const pg = Number(page);
    // Rotate through multiple feed tabs for pagination variety
    const feedTabs = ['recommend', 'new', 'ranked', 'war', 'epic', 'romance'];
    const tab = feedTabs[(pg - 1) % feedTabs.length];
    const response = await axios.get(`${shortmaxBase}/api/v1/feed/${tab}`, {
      params: { lang, page: pg },
      headers: { Authorization: `Bearer ${shortmaxToken}` }
    });
    // ShortMax returns array or object with sections
    const raw = response.data?.data;
    let list: any[] = [];
    if (Array.isArray(raw)) {
      list = raw;
    } else if (raw && typeof raw === 'object') {
      // ranked returns { hot, new, completed } sections
      list = Object.values(raw).flat().filter((d: any) => d && d.code);
    }
    const mapped = list.map((d: any) => ({
      id: d.code || d.id,
      title: d.name || d.title,
      poster: d.cover,
      episodes: d.episodes || d.total || 0,
      likes: d.views ? (d.views > 1000000 ? (d.views / 1000000).toFixed(1) + 'M' : d.views > 1000 ? (d.views / 1000).toFixed(1) + 'K' : String(d.views)) : '0',
      platform: 'SHORTMAX'
    })).filter((d: any) => d.id && d.title);
    res.json({ dramas: mapped, platform: 'SHORTMAX' });
  } catch (error: any) {
    console.error('ShortMax Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortmax/search', async (req, res) => {
  try {
    const { keyword, q, lang = 'id', page = 1 } = req.query;
    const kw = keyword || q || '';
    const response = await axios.get(`${shortmaxBase}/api/v1/search`, {
      params: { q: kw, lang, page },
      headers: { Authorization: `Bearer ${shortmaxToken}` }
    });
    const raw = response.data?.data;
    const list: any[] = Array.isArray(raw) ? raw : [];
    const mapped = list.map((d: any) => ({
      id: d.code || d.id,
      title: d.name || d.title,
      poster: d.cover,
      episodes: d.episodes || 0,
      likes: '0',
      platform: 'SHORTMAX'
    })).filter((d: any) => d.id && d.title);
    res.json({ dramas: mapped, platform: 'SHORTMAX' });
  } catch (error: any) {
    console.error('ShortMax Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortmax/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${shortmaxBase}/api/v1/detail/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${shortmaxToken}` }
    });
    const detail = response.data?.data || {};
    const totalEps = detail.episodes || 0;
    // Build episode list from total count
    const list = Array.from({ length: totalEps }, (_, i) => ({
      id: String(i + 1),
      title: `Episode ${i + 1}`,
      episNum: i + 1,
      isVip: false
    }));
    res.json({ data: { list, detail }, platform: 'SHORTMAX' });
  } catch (error: any) {
    console.error('ShortMax Episodes error:', error.message);
    res.json({ data: { list: [] }, platform: 'SHORTMAX' });
  }
});

app.get('/api/shortmax/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id', quality = '1080' } = req.query;
    const response = await axios.get(`${shortmaxBase}/api/v1/play/${id}`, {
      params: { ep: parseInt(ep), lang },
      headers: { Authorization: `Bearer ${shortmaxToken}` }
    });
    const video = response.data?.data?.video || {};
    // Pick quality: prefer requested quality, fall back to available
    const q = String(quality);
    const videoUrl = video[`video_${q}`] || video.video_1080 || video.video_720 || video.video_480 || '';
    if (videoUrl) {
      const serverHost = req.headers.host || '127.0.0.1:5001';
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(videoUrl)}`;
      res.json({ data: { url: proxiedUrl }, platform: 'SHORTMAX' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('ShortMax Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'SHORTMAX' });
  }
});

// --- Melolo Routes ---
const melloloBase = process.env.MELOLO_BASE_URL;
const melloloToken = process.env.MELOLO_TOKEN;

// Helper to proxy Melolo image URLs (HEIC → JPEG via server)
const proxyMelloloImage = (url: string, reqHost = '127.0.0.1:5001', protocol = 'http') => {
  if (!url) return '';
  if (url.includes('fizzopic.org') || url.includes('ibyteimg.com')) {
    return url.split('?')[0]
      .replace('fizzopic.org', 'ibyteimg.com')
      .replace('-sign-', '-')
      .replace(/\.heic$/i, '.jpeg')
      .replace(/\.heif$/i, '.jpeg');
  }
  return `${protocol}://${reqHost}/api/proxy/image?url=${encodeURIComponent(url)}`;
};

// Helper to map Melolo book to normalized format
const mapMelloloBook = (b: any, reqHost?: string, protocol = 'http') => {
  // Support both bookmall books (book_id/book_name/thumb_url) and series format
  const id = String(b.book_id || b.series_id || b.id || '');
  const title = b.book_name || b.title || b.name || '';
  const rawPoster = b.first_chapter_cover || b.thumb_url || b.cover || b.poster || '';
  // Proxy through image endpoint so HEIC renders in browser
  const poster = rawPoster ? proxyMelloloImage(rawPoster, reqHost, protocol) : '';
  const episodes = b.serial_count || b.episode_count || b.total_episodes || 0;
  const rawCount = parseInt(String(b.read_count || b.play_count || 0));
  const likes = rawCount > 1000000 ? (rawCount / 1000000).toFixed(1) + 'M'
    : rawCount > 1000 ? (rawCount / 1000).toFixed(1) + 'K'
    : rawCount > 0 ? String(rawCount) : '0';
  return { id, title, poster, episodes, likes, platform: 'MELOLO' };
};

app.get('/api/melolo/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const pg = Number(page);
    let list: any[] = [];
    
    if (pg === 1) {
      const response = await axios.get(`${melloloBase}/api/v1/bookmall`, {
        params: { lang, offset: 0 },
        headers: { Authorization: `Bearer ${melloloToken}` }
      });
      const cell = response.data?.cell || {};
      const cellData: any[] = Array.isArray(cell.cell_data) ? cell.cell_data : [];
      cellData.forEach((section: any) => {
        const books: any[] = Array.isArray(section.books) ? section.books : [];
        books.forEach((b: any) => list.push(b));
      });
    } else {
      const offset = (pg - 2) * 20;
      const response = await axios.get(`${melloloBase}/api/v1/search`, {
        params: { q: 'a', lang, limit: 20, offset },
        headers: { Authorization: `Bearer ${melloloToken}` }
      });
      list = response.data?.items || response.data?.series_list || response.data?.books || response.data?.results || [];
    }

    // Deduplicate by book_id
    const seen = new Set<string>();
    const unique = list.filter(b => {
      const k = String(b.book_id || b.series_id || b.id || '');
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    
    const reqHost = req.headers.host || '127.0.0.1:5001';
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    
    const dramas = await Promise.all(unique.map(async (b: any) => {
      let mapped = mapMelloloBook(b, reqHost, protocol);
      if (!mapped.poster && mapped.id) {
        try {
          const bRes = await axios.get(`${melloloBase}/api/v1/book`, {
            params: { id: mapped.id, lang },
            headers: { Authorization: `Bearer ${melloloToken}` }
          });
          const bData = bRes.data;
          const bCover = bData?.first_chapter_cover || bData?.cover || bData?.extra?.book_info?.first_chapter_cover || bData?.extra?.book_info?.thumb_url || bData?.extra?.book_info?.cover;
          if (bCover) {
            mapped.poster = proxyMelloloImage(bCover, reqHost, protocol);
          }
        } catch {}
      }
      return mapped;
    }));

    res.json({ dramas: dramas.filter(d => d.id && d.title), platform: 'MELOLO' });
  } catch (error: any) {
    console.error('Melolo Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/melolo/search', async (req, res) => {
  try {
    const { keyword, q, lang = 'id', page = 1 } = req.query;
    const kw = keyword || q || '';
    const offset = (Number(page) - 1) * 20;
    const response = await axios.get(`${melloloBase}/api/v1/search`, {
      params: { q: kw, lang, limit: 20, offset },
      headers: { Authorization: `Bearer ${melloloToken}` }
    });
    const list = response.data?.items || response.data?.series_list || response.data?.books || response.data?.results || [];
    const reqHost2 = req.headers.host || '127.0.0.1:5001';
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    
    const dramas = await Promise.all(list.map(async (b: any) => {
      let mapped = mapMelloloBook(b, reqHost2, protocol);
      if (!mapped.poster && mapped.id) {
        try {
          const bRes = await axios.get(`${melloloBase}/api/v1/book`, {
            params: { id: mapped.id, lang },
            headers: { Authorization: `Bearer ${melloloToken}` }
          });
          const bData = bRes.data;
          const bCover = bData?.first_chapter_cover || bData?.cover || bData?.extra?.book_info?.first_chapter_cover || bData?.extra?.book_info?.thumb_url || bData?.extra?.book_info?.cover;
          if (bCover) {
            mapped.poster = proxyMelloloImage(bCover, reqHost2, protocol);
          }
        } catch {}
      }
      return mapped;
    }));
    
    res.json({ dramas: dramas.filter(d => d.id && d.title), platform: 'MELOLO' });
  } catch (error: any) {
    console.error('Melolo Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/melolo/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    
    const [seriesRes, bookRes] = await Promise.allSettled([
      axios.get(`${melloloBase}/api/v1/series`, {
        params: { id, lang },
        headers: { Authorization: `Bearer ${melloloToken}` }
      }),
      axios.get(`${melloloBase}/api/v1/book`, {
        params: { id, lang },
        headers: { Authorization: `Bearer ${melloloToken}` }
      })
    ]);

    const series = seriesRes.status === 'fulfilled' ? (seriesRes.value.data?.series || {}) : {};
    const episodes = seriesRes.status === 'fulfilled' ? (seriesRes.value.data?.episodes || []) : [];

    if (bookRes.status === 'fulfilled') {
      const bData = bookRes.value.data;
      const bCover = bData?.first_chapter_cover || bData?.cover || bData?.extra?.book_info?.first_chapter_cover || bData?.extra?.book_info?.thumb_url || bData?.extra?.book_info?.cover;
      if (bCover) {
        series.cover = bCover;
      }
    }

    const reqHost = req.headers.host || '127.0.0.1:5001';
    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    if (series.cover) {
      series.cover = proxyMelloloImage(series.cover, reqHost, protocol);
    }

    const list = episodes.map((ep: any) => ({
      id: ep.vid || String(ep.index),
      title: `Episode ${ep.index}`,
      episNum: ep.index,
      cover: ep.cover ? proxyMelloloImage(ep.cover, reqHost, protocol) : '',
      isVip: ep.need_unlock || ep.needUnlock || false
    }));
    
    res.json({ data: { list, series }, platform: 'MELOLO' });
  } catch (error: any) {
    console.error('Melolo Episodes error:', error.message);
    res.json({ data: { list: [] }, platform: 'MELOLO' });
  }
});

app.get('/api/melolo/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const epNum = parseInt(ep);
    const { lang = 'id' } = req.query;
    // Use multi-video to get all stream URLs (cached 30min on API side)
    const response = await axios.get(`${melloloBase}/api/v1/multi-video`, {
      params: { id, lang },
      headers: { Authorization: `Bearer ${melloloToken}` }
    });
    const episodes = response.data?.episodes || [];
    const match = episodes.find((e: any) => e.index === epNum) || episodes[epNum - 1];
    if (match && match.stream_url) {
      const serverHost = req.headers.host || '127.0.0.1:5001';
      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(match.stream_url)}`;
      res.json({ data: { url: proxiedUrl }, platform: 'MELOLO' });
    } else {
      res.json({ data: { url: '' }, error: 'Episode not found' });
    }
  } catch (error: any) {
    console.error('Melolo Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'MELOLO' });
  }
});

app.get('/api/melolo/subtitle/:id/:ep', async (req, res) => {
  // Melolo doesn't have a subtitle endpoint — return empty
  res.json({ data: [], platform: 'MELOLO' });
});


app.get('/api/moboreels/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = '11' } = req.query;
    const langId = lang === 'id' ? '11' : lang;
    const response = await axios.get(`${moboBase}/api/video`, {
      params: { seriesId: id, episNum: ep, langId },
      headers: {
        ...moboHeaders(),
        Referer: 'https://www.cdreader.com/'
      }
    });
    const moboData = response.data?.data || response.data;
    const { quality = '1080' } = req.query;
    
    let videoUrl = moboData?.mediaUrl || moboData?.url || moboData?.videoUrl;
    
    // Attempt to pick specific quality if available
    if (moboData?.episMedia && Array.isArray(moboData.episMedia)) {
      const qNum = parseInt(String(quality));
      const match = moboData.episMedia.find((m: any) => m.resolution === qNum) 
                 || moboData.episMedia.find((m: any) => m.resolution <= qNum);
      if (match) videoUrl = match.mediaUrl;
    }

    const serverHost = req.headers.host || '127.0.0.1:5001';
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const proxiedUrl = `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(videoUrl)}`;
    
    res.json({ data: { url: proxiedUrl }, platform: 'MOBOREELS' });
  } catch (error: any) {
    console.error('MoboReels Stream error:', error.message);
    res.status(500).json({ error: 'MoboReels Stream failed' });
  }
});

// MoboReels: Subtitle proxy
// MoboReels: Subtitle proxy
// Generic Subtitle Proxy
app.get('/api/proxy/subtitle', async (req, res) => {
  try {
    const { url, lang = 'id' } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const list = await standardizeSubtitles(String(url));
    res.json({ data: { list }, platform: 'PROXY' });
  } catch (error: any) {
    console.error('[Subtitle Proxy] Error:', error.message);
    res.status(500).json({ error: 'Subtitle proxy failed' });
  }
});

// MoboReels: Subtitle proxy
app.get('/api/moboreels/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = '11' } = req.query;
    const langId = lang === 'id' ? '11' : lang;
    
    let episId = ep;
    if (ep.length < 5) {
      const epNum = parseInt(ep);
      const seriesRes = await axios.get(`${moboBase}/api/seriesPage`, {
        params: { seriesId: id, pageNo: 1, pageSize: 200, langId },
        headers: moboHeaders()
      });
      const items = seriesRes.data?.data?.episodeVos || seriesRes.data?.data?.items || [];
      const match = items.find((i: any) => i.episNum === epNum);
      if (match) episId = match.episId;
    }

    const response = await axios.get(`${moboBase}/api/proxy/subtitle`, {
      params: { episId, langId },
      headers: moboHeaders()
    });

    const moboSub = response.data?.data?.list || response.data?.data || response.data;
    const list = await standardizeSubtitles(moboSub);

    res.json({ 
      data: { list }, 
      platform: 'MOBOREELS',
      style: {
        fontFamily: 'Standard Symbols PS',
        fontSize: '18px',
        fontWeight: 'bold',
        color: 'white',
        outline: '2px black',
        offset: '55%'
      }
    });
  } catch (error: any) {
    console.error('MoboReels Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'MOBOREELS' });
  }
});


// VIP status check for TeamDl
app.get('/api/vip-check/:userId', (req, res) => {
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

// --- BiliTV Routes ---
const bilitvBase = process.env.BILITV_BASE_URL || 'https://captain.sapimu.au/bilitv/api/v1';
const bilitvToken = process.env.BILITV_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/bilitv/home', async (req, res) => {
  const cacheKey = `bilitv_home_${req.query.page}_${req.query.lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { page = 1, limit = 30, lang = 'id' } = req.query;
    console.log(`[BiliTV] Fetching home from: ${bilitvBase}`);
    const response = await axios.get(`${bilitvBase}/home`, {
      params: { page, limit, lang },
      headers: { Authorization: `Bearer ${bilitvToken}` }
    });
    const list = response.data?.dramas || [];
    const result = { dramas: list, platform: 'BILITV' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('BiliTV Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/bilitv/search', async (req, res) => {
  const cacheKey = `bilitv_search_${req.query.q}_${req.query.lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { q = '', lang = 'id', limit = 30 } = req.query;
    const response = await axios.get(`${bilitvBase}/search`, {
      params: { q, lang, limit },
      headers: { Authorization: `Bearer ${bilitvToken}` }
    });
    const list = response.data?.dramas || [];
    const result = { dramas: list, platform: 'BILITV' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('BiliTV Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/bilitv/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${bilitvBase}/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${bilitvToken}` }
    });
    const seriesData = response.data || {};
    const episodes = seriesData.episodes || [];
    
    const list = episodes.map((ep: any) => ({
      id: ep.id || ep.number,
      title: ep.title || `Episode ${ep.number}`,
      episNum: ep.number,
      cover: seriesData.cover || '',
      isVip: !ep.free
    }));

    res.json({ data: { list, series: seriesData }, platform: 'BILITV' });
  } catch (error: any) {
    console.error('BiliTV Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'BILITV' });
  }
});

app.get('/api/bilitv/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = 720, lang = 'id' } = req.query;
    
    const response = await axios.get(`${bilitvBase}/drama/${id}/episode/${ep}`, {
      params: { quality, lang },
      headers: { Authorization: `Bearer ${bilitvToken}` }
    });
    
    const epData = response.data || {};
    let streamUrl = epData.video || epData.url || '';
    
    if (!streamUrl && epData.qualities) {
      streamUrl = epData.qualities[String(quality)] || epData.qualities['720'] || Object.values(epData.qualities)[0] || '';
    }

    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=BILITV`;
      res.json({ data: { url: proxiedUrl }, platform: 'BILITV' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('BiliTV Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'BILITV' });
  }
});

app.get('/api/bilitv/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id', format = 'vtt' } = req.query;
    const response = await axios.get(`${bilitvBase}/subtitle/${id}/${ep}`, {
      params: { lang, format },
      headers: { Authorization: `Bearer ${bilitvToken}` }
    });

    const biliSub = response.data?.data?.vtt || response.data?.data?.list || response.data;
    const list = await standardizeSubtitles(biliSub);
    res.json({ data: { list }, platform: 'BILITV' });
  } catch (error: any) {
    if (error.response?.status === 404) {
      return res.json({ data: { list: [] }, message: 'No subtitles found', platform: 'BILITV' });
    }
    console.error('BiliTV Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'BILITV' });
  }
});

app.get('/api/reelala/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'REELALA' });
});

app.get('/api/reelshort/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'REELSHORT' });
});

app.get('/api/moboreels/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'MOBOREELS' });
});

app.get('/api/shortmax/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'SHORTMAX' });
});

app.get('/api/melolo/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'MELOLO' });
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

// Video Stream Proxy (Bypass 403)
// Image proxy for HEIC CDN images from Melolo (fizzopic/ByteDance CDN)
app.get('/api/proxy/image', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL required');
    const originalUrl = String(url);
    // Set Referer based on image domain
    let referer = 'https://www.melolo.video/';
    try {
      const imgDomain = new URL(originalUrl).origin;
      if (originalUrl.includes('goodreels.com') || originalUrl.includes('goodshort')) referer = 'https://www.goodshort.com/';
      else if (originalUrl.includes('janzhoutec.com') || originalUrl.includes('reeltv')) referer = 'https://www.microdrama.com/';
      else referer = imgDomain + '/';
    } catch {}
    const reqHeaders = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120.0',
      'Accept': 'image/webp,image/jpeg,image/png,image/*;q=0.8',
      'Referer': referer
    };
    // Strategy 1: Replace .heic extension with .jpeg (ByteDance CDN supports format switching)
    let jpegUrl = originalUrl;
    if (originalUrl.includes('fizzopic.org') || originalUrl.includes('ibyteimg.com')) {
      // Don't strip -sign- as it might be required for the signature/auth
      jpegUrl = originalUrl.replace(/\.heic$/i, '.jpeg').replace(/\.heif$/i, '.jpeg');
      if (originalUrl.includes('fizzopic.org')) {
        jpegUrl = jpegUrl.replace('fizzopic.org', 'ibyteimg.com');
      }
    } else {
      jpegUrl = originalUrl.replace(/\.heic(\?|$)/gi, '.jpeg$1').replace(/\.heif(\?|$)/gi, '.jpeg$1');
    }

    console.log(`[ImageProxy] Fetching: ${jpegUrl} (Original: ${originalUrl})`);
    
    let imgRes: any = null;
    if (jpegUrl !== originalUrl) {
      try {
        imgRes = await axios.get(jpegUrl, { responseType: 'arraybuffer', headers: reqHeaders, timeout: 8000 });
        const ctCheck = String(imgRes.headers['content-type'] || '');
        if (!ctCheck.includes('image') && (imgRes.data?.length || 0) < 1000) imgRes = null;
      } catch { imgRes = null; }
    }
    // Strategy 2: Fallback to original URL
    if (!imgRes) {
      imgRes = await axios.get(originalUrl, { responseType: 'arraybuffer', headers: reqHeaders, timeout: 8000 });
    }
    const ct = String(imgRes.headers['content-type'] || 'image/jpeg');
    const serveAs = (ct.includes('heic') || ct.includes('heif')) ? 'image/jpeg' : ct;
    res.set('Content-Type', serveAs);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    return res.send(Buffer.from(imgRes.data));
  } catch (err: any) {
    console.error('Image proxy error:', err.message);
    const fallback = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.set('Content-Type', 'image/png');
    return res.send(fallback);
  }
});

app.get('/api/proxy/video', async (req, res) => {
  try {
    const { url, platform, key } = req.query;
    if (!url) return res.status(400).send('URL is required');

    const videoUrl = String(url);
    const injectKey = key ? String(key) : null;
    
    // Handle local placeholders used by some CDNs for offline keys
    if (videoUrl.startsWith('local://')) {
      console.log('[Proxy] Skipping local placeholder:', videoUrl);
      return res.status(204).end();
    }

    const isM3U8 = videoUrl.includes('.m3u8');
    const isKey = videoUrl.includes('/keys') || videoUrl.includes('.key') || videoUrl.includes('key');
    const urlObj = new URL(videoUrl);
    
    // Stealth browser headers
    const headers: any = {
      'Host': urlObj.host,
      'Connection': 'keep-alive',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': (isM3U8 || isKey) ? '*/*' : 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': (isM3U8 || isKey) ? 'cors' : 'no-cors',
      'Sec-Fetch-Dest': (isM3U8 || isKey) ? 'empty' : 'video',
    };

    // Platform specific header tuning
    if (platform === 'BILITV' || videoUrl.includes('bilibili')) {
      headers['Referer'] = 'https://www.bilibili.tv/';
      headers['Origin'] = 'https://www.bilibili.tv';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Site'] = 'cross-site';
    } else if (platform === 'MOBOREELS' || videoUrl.includes('cdreader.com') || videoUrl.includes('moboreels.com')) {
      headers['Referer'] = 'https://www.moboreels.com/';
      headers['Origin'] = 'https://www.moboreels.com';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Site'] = 'cross-site';
    } else if (platform === 'REELALA' || videoUrl.includes('reelala')) {
      headers['Referer'] = 'https://www.reelala.com/';
    } else if (platform === 'MELOLO' || videoUrl.includes('melolo') || videoUrl.includes('fizzopic')) {
      headers['Referer'] = 'https://www.melolo.video/';
    } else if (platform === 'DRAMABOX' || videoUrl.includes('dramabox')) {
      headers['Referer'] = 'https://www.dramabox.com/';
      headers['Origin'] = 'https://www.dramabox.com';
    } else if (platform === 'SHORTMAX' || videoUrl.includes('shortmax')) {
      headers['Referer'] = 'https://www.shortmax.tv/';
      headers['Origin'] = 'https://www.shortmax.tv';
    } else if (platform === 'SHORTSWAVE' || videoUrl.includes('shortswave') || videoUrl.includes('dramabos.my.id')) {
      headers['Referer'] = 'https://shortswave.com/';
      headers['Origin'] = 'https://shortswave.com';
      headers['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
      headers['Sec-Fetch-Site'] = 'cross-site';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Dest'] = 'empty';
    } else if (platform === 'FLEXTV' || videoUrl.includes('flextv.com')) {
      headers['Referer'] = 'https://www.flextv.com/';
      headers['Origin'] = 'https://www.flextv.com';
    } else if (platform === 'GOODSHORT' || videoUrl.includes('goodshort') || videoUrl.includes('foshort.com')) {
      headers['Referer'] = 'https://www.goodshort.com/';
      headers['Origin'] = 'https://www.goodshort.com';
      headers['Sec-Fetch-Mode'] = 'cors';
      headers['Sec-Fetch-Dest'] = 'empty';
      headers['Sec-Fetch-Site'] = 'cross-site';
    } else if (platform === 'DRAMAWAVE' || platform === 'ANIME_WAVE' || videoUrl.includes('dramawave') || videoUrl.includes('mydramawave.com')) {
      headers['Referer'] = 'https://www.dramawave.com/';
      headers['Origin'] = 'https://www.dramawave.com';
    } else if (platform === 'ANIME_CUBE' || videoUrl.includes('cubetv.cc')) {
      headers['Referer'] = 'https://www.cubetv.cc/';
      headers['Origin'] = 'https://www.cubetv.cc';
    } else if (platform === 'SHORTBOX' || videoUrl.includes('bytedrama.com') || videoUrl.includes('bytedance.com')) {
      headers['Referer'] = 'https://www.cdreader.com/';
      headers['Origin'] = 'https://www.cdreader.com';
    } else {
      headers['Referer'] = 'https://www.cdreader.com/';
    }

    if (req.headers.range) headers['Range'] = req.headers.range;

    const outgoingProxy = getProxy();
    const axiosConfig: any = {
      method: 'get',
      url: videoUrl,
      headers,
      timeout: 30000,
      validateStatus: null,
      httpAgent: keepAliveHttpAgent,
      httpsAgent: keepAliveHttpsAgent,
      maxRedirects: 5,
      https: { rejectUnauthorized: false }
    };

    if (outgoingProxy) {
      axiosConfig.httpsAgent = new HttpsProxyAgent(outgoingProxy);
      axiosConfig.proxy = false;
    }

    // Handle SRT to VTT conversion
    if (videoUrl.split('?')[0].toLowerCase().endsWith('.srt')) {
      console.log(`[Proxy] Converting SRT to VTT:`, videoUrl.substring(0, 60) + '...');
      const response = await axios({ ...axiosConfig, responseType: 'text' });
      let srt = response.data;
      // Simple SRT to VTT: Add header and replace comma with dot in timestamps
      // Also add 'line:75%' to position subtitles towards the middle-bottom as requested
      let vtt = "WEBVTT\n\n" + srt
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3}) --> (\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2 --> $3.$4 line:75%');
      
      res.set('Content-Type', 'text/vtt');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(vtt);
    }

    if (isM3U8) {
      console.log(`[Proxy] HLS Manifest (${platform}):`, videoUrl.substring(0, 60) + '...');
      const response = await axios({ ...axiosConfig, responseType: 'text' });
      
      if (response.status === 403) {
        console.error(`[Proxy] 403 Forbidden for ${platform}: ${videoUrl}`);
        return res.status(403).json({ error: 'CDN_BLOCKED', message: 'Access denied by CDN', platform });
      }

      if (response.status !== 200 && response.status !== 206) {
        console.error(`[Proxy] UPSTREAM_ERROR ${response.status} for ${videoUrl.substring(0, 100)}...`);
        return res.status(response.status).json({ error: 'UPSTREAM_ERROR', status: response.status, url: videoUrl });
      }

      let content = response.data;
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const serverHost = req.get('host') || req.headers.host || '127.0.0.1:5001';
      const baseUrl = videoUrl.split('?')[0].substring(0, videoUrl.split('?')[0].lastIndexOf('/') + 1);
      const manifestUrlObj = new URL(videoUrl);
      const manifestParams = manifestUrlObj.search;

      const lines = content.split('\n');
      const rewrittenLines = lines.map((line: string) => {
        const trimmed = line.trim();
        
        // Handle tags with URIs (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA)
        if (trimmed.startsWith('#EXT-X-KEY') || trimmed.startsWith('#EXT-X-MAP') || trimmed.startsWith('#EXT-X-MEDIA')) {
          let processedLine = line;
          
          // Force Indonesian audio track as default
          if (trimmed.startsWith('#EXT-X-MEDIA') && processedLine.includes('TYPE=AUDIO')) {
            const isIndo = /LANGUAGE="(id|in|ind|id-ID)"/i.test(processedLine) || /NAME="[^"]*(indo|id-ID)[^"]*"/i.test(processedLine);
            if (isIndo) {
              processedLine = processedLine.replace(/DEFAULT=NO/i, 'DEFAULT=YES').replace(/AUTOSELECT=NO/i, 'AUTOSELECT=YES');
              // If it doesn't have DEFAULT=YES yet, we might need to add it, but usually the tag has DEFAULT=NO
            } else {
              processedLine = processedLine.replace(/DEFAULT=YES/i, 'DEFAULT=NO').replace(/AUTOSELECT=YES/i, 'AUTOSELECT=NO');
            }
          }

          return processedLine.replace(/URI="([^"]+)"/g, (match, p1) => {
            if (trimmed.startsWith('#EXT-X-KEY') && injectKey) {
              return `URI="data:text/plain;base64,${injectKey}"`;
            }
            if (p1.startsWith('local://')) return match; 
            let u = p1;
            try {
              if (!p1.startsWith('http')) {
                const resolved = new URL(p1, baseUrl);
                if (!resolved.search && manifestParams) resolved.search = manifestParams;
                u = resolved.href;
              }
            } catch (e) {}
            return `URI="${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(u)}${platform ? `&platform=${platform}` : ''}${injectKey ? `&key=${encodeURIComponent(injectKey)}` : ''}"`;
          });
        }

        if (!trimmed || trimmed.startsWith('#')) return line;
        if (trimmed.startsWith('local://')) return line;
        
        let fullUrl = trimmed;
        try {
          if (!trimmed.startsWith('http')) {
            const resolved = new URL(trimmed, baseUrl);
            // Inherit manifest params if segment has none
            if (!resolved.search && manifestParams) resolved.search = manifestParams;
            fullUrl = resolved.href;
          }
        } catch (e) {
          return line;
        }
        return `${protocol}://${serverHost}/api/proxy/video?url=${encodeURIComponent(fullUrl)}${platform ? `&platform=${platform}` : ''}${injectKey ? `&key=${encodeURIComponent(injectKey)}` : ''}`;
      });
      
      content = rewrittenLines.join('\n');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      return res.send(content);
    }

    // Normal segment proxy
    const response = await axios({ ...axiosConfig, responseType: 'stream' });

    res.set({
      'Content-Type': response.headers['content-type'] || (videoUrl.includes('.ts') ? 'video/mp2t' : 'video/mp4'),
      'Content-Length': response.headers['content-length'],
      'Content-Range': response.headers['content-range'],
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });

    res.status(response.status);
    response.data.pipe(res);
    response.data.on('error', () => res.end());
  } catch (error: any) {
    console.error('[Proxy] Error:', error.message);
    if (!res.headersSent) res.status(500).send('Proxy error');
  }
});

// --- Fundrama Routes ---
const fundramaBase = process.env.FUNDRAMA_BASE_URL || 'https://captain.sapimu.au/fundrama';
const fundramaToken = process.env.FUNDRAMA_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/fundrama/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const response = await axios.get(`${fundramaBase}/api/v1/dramas`, {
      params: { lang, page, limit: 30 },
      headers: { Authorization: `Bearer ${fundramaToken}` }
    });
    const list = response.data?.data?.ddriv?.lsumm || response.data?.data?.lsumm || [];
    const mapped = list.map((d: any) => ({
      id: d.dshame || d.id,
      title: d.nsin || d.title || '',
      poster: d.ptear || d.cover || '',
      episodes: parseInt(d.eshe || d.episodes) || 0,
      likes: d.coper || d.likes || '0',
      platform: 'FUNDRAMA'
    }));
    res.json({ dramas: mapped, platform: 'FUNDRAMA' });
  } catch (error: any) {
    console.error('Fundrama Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/fundrama/search', async (req, res) => {
  try {
    const { q = '', lang = 'id' } = req.query;
    const response = await axios.get(`${fundramaBase}/api/v1/search`, {
      params: { q, lang },
      headers: { Authorization: `Bearer ${fundramaToken}` }
    });
    const list = response.data?.data?.ddriv?.lsumm || response.data?.data?.lsumm || response.data?.data?.list || [];
    const mapped = list.map((d: any) => ({
      id: d.dshame || d.id,
      title: d.nsin || d.title || '',
      poster: d.ptear || d.cover || '',
      episodes: parseInt(d.eshe || d.episodes) || 0,
      likes: d.coper || d.likes || '0',
      platform: 'FUNDRAMA'
    }));
    res.json({ dramas: mapped, platform: 'FUNDRAMA' });
  } catch (error: any) {
    console.error('Fundrama Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/fundrama/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const [seriesRes, epsRes] = await Promise.allSettled([
      axios.get(`${fundramaBase}/api/v1/drama/${id}`, {
        headers: { Authorization: `Bearer ${fundramaToken}` }
      }),
      axios.get(`${fundramaBase}/api/v1/drama/${id}/episodes`, {
        params: { lang },
        headers: { Authorization: `Bearer ${fundramaToken}` }
      })
    ]);
    const seriesData = seriesRes.status === 'fulfilled' ? (seriesRes.value.data?.data?.ddriv || seriesRes.value.data?.data || {}) : {};
    
    const series = {
      id: seriesData.dshame || id,
      title: seriesData.nsin || '',
      cover: seriesData.ptear || '',
      description: seriesData.dentra || ''
    };

    let epsData = epsRes.status === 'fulfilled' ? (epsRes.value.data?.data?.episodes || epsRes.value.data?.data || []) : [];
    
    const list = epsData.map((ep: any) => ({
      id: ep.id || ep.episode,
      title: `Episode ${ep.episode}`,
      episNum: ep.episode,
      cover: series.cover,
      isVip: false
    }));

    res.json({ data: { list, series }, platform: 'FUNDRAMA' });
  } catch (error: any) {
    console.error('Fundrama Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'FUNDRAMA' });
  }
});

app.get('/api/fundrama/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = '720P' } = req.query;
    const response = await axios.get(`${fundramaBase}/api/v1/drama/${id}/episode/${ep}`, {
      params: { quality },
      headers: { Authorization: `Bearer ${fundramaToken}` }
    });
    
    const epData = response.data?.data || {};
    let streamUrl = epData.url || epData.video_url || '';
    
    if (!streamUrl && Array.isArray(epData.fdar)) {
      const qualVideo = epData.fdar.find((v: any) => v.Dspee === quality) || epData.fdar[0];
      streamUrl = qualVideo?.Mbrie || qualVideo?.Bcance;
    } else if (epData.videos && Array.isArray(epData.videos)) {
      const qv = epData.videos.find((v:any) => v.quality === quality || v.Dspee === quality) || epData.videos[0];
      streamUrl = qv?.url || qv?.video_url || qv?.Mbrie;
    }

    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=FUNDRAMA`;
      res.json({ data: { url: proxiedUrl }, platform: 'FUNDRAMA' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('Fundrama Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'FUNDRAMA' });
  }
});

app.get('/api/fundrama/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'FUNDRAMA' });
});

// --- DramaPops Routes ---
const dramapopsBase = process.env.DRAMAPOPS_BASE_URL || 'https://captain.sapimu.au/dramapops';
const dramapopsToken = process.env.DRAMAPOPS_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/dramapops/home', async (req, res) => {
  try {
    const { lang = 'id', limit = 30 } = req.query;
    const response = await axios.get(`${dramapopsBase}/api/v1/dramas`, {
      params: { lang, limit },
      headers: { Authorization: `Bearer ${dramapopsToken}` }
    });
    const list = response.data?.data || [];
    res.json({ dramas: list, platform: 'DRAMAPOPS' });
  } catch (error: any) {
    console.error('DramaPops Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramapops/search', async (req, res) => {
  try {
    const { q = '', lang = 'id', limit = 30 } = req.query;
    const response = await axios.get(`${dramapopsBase}/api/v1/search`, {
      params: { q, lang, limit },
      headers: { Authorization: `Bearer ${dramapopsToken}` }
    });
    const list = response.data?.data || [];
    res.json({ dramas: list, platform: 'DRAMAPOPS' });
  } catch (error: any) {
    console.error('DramaPops Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramapops/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${dramapopsBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramapopsToken}` }
    });
    const seriesData = response.data?.data || {};
    const prices = seriesData.episode_prices || {};
    
    // Prioritize seriesData.totalEpisodes if it's a valid number > 0
    let totalEp = 0;
    if (seriesData.totalEpisodes && seriesData.totalEpisodes > 0) {
      totalEp = seriesData.totalEpisodes;
    } else {
      // Fallback to prices keys, but be careful with 0-index
      const keys = Object.keys(prices).map(Number);
      if (keys.length > 0) {
        totalEp = Math.max(...keys) + 1;
      } else {
        totalEp = 50; // hard fallback
      }
    }
    
    const list = [];
    for (let i = 1; i <= totalEp; i++) {
      list.push({
        id: String(i),
        title: `Episode ${i}`,
        episNum: i,
        cover: seriesData.poster || '',
        isVip: (prices[String(i)] || prices[String(i-1)] || 0) > 0
      });
    }

    res.json({ data: { list, series: seriesData }, platform: 'DRAMAPOPS' });
  } catch (error: any) {
    console.error('DramaPops Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'DRAMAPOPS' });
  }
});

app.get('/api/dramapops/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality: reqQuality, lang = 'id' } = req.query;
    
    // DramaPops usually likes '720p' style or just '720'. 
    // We try requested quality first, then fallbacks.
    const qualitiesToTry = [];
    if (reqQuality) {
      qualitiesToTry.push(String(reqQuality));
      if (!String(reqQuality).endsWith('p')) qualitiesToTry.push(`${reqQuality}p`);
      else qualitiesToTry.push(String(reqQuality).replace('p', ''));
    }
    qualitiesToTry.push('720p', '720', '360p', '360');

    let streamUrl = '';
    for (const q of qualitiesToTry) {
      try {
        const response = await axios.get(`${dramapopsBase}/api/v1/drama/${id}/episode/${ep}/video`, {
          params: { quality: q, lang },
          headers: { Authorization: `Bearer ${dramapopsToken}` },
          timeout: 5000
        });
        const epData = response.data?.data || {};
        streamUrl = epData.videoUrl || epData.url || '';
        if (streamUrl) {
          console.log(`[DramaPops] Success with quality ${q} for EP ${ep}`);
          break;
        }
      } catch (e) {
        // continue to next quality
      }
    }
    
    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=DRAMAPOPS`;
      res.json({ data: { url: proxiedUrl }, platform: 'DRAMAPOPS' });
    } else {
      console.warn(`[DramaPops] All qualities failed for ID=${id} EP=${ep}`);
      res.json({ data: { url: '' }, error: 'No video URL found after trying all qualities' });
    }
  } catch (error: any) {
    console.error('DramaPops Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'DRAMAPOPS' });
  }
});

app.get('/api/dramapops/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    let { lang = 'id' } = req.query;
    
    // Map short lang codes to DramaPops codes
    const langMap: any = { 'id': 'ind-ID', 'in': 'ind-ID', 'en': 'eng-US' };
    const targetLang = langMap[lang as string] || 'ind-ID';

    const response = await axios.get(`${dramapopsBase}/api/v1/drama/${id}/episode/${ep}/video`, {
      params: { quality: '360p', lang: 'id' }, 
      headers: { Authorization: `Bearer ${dramapopsToken}` }
    });
    
    const subs = response.data?.data?.subtitles || [];
    // Find matching lang, or ind-ID, or eng-US, or first one
    const sub = subs.find((s: any) => s.language === targetLang)
             || subs.find((s: any) => s.language === 'ind-ID')
             || subs.find((s: any) => s.language === 'eng-US')
             || subs.find((s: any) => s.language.startsWith('en'))
             || subs[0];

    if (sub && sub.url) {
      const list = await standardizeSubtitles(sub.url);
      res.json({ data: { list }, platform: 'DRAMAPOPS' });
    } else {
      res.json({ data: { list: [] }, platform: 'DRAMAPOPS' });
    }
  } catch (error: any) {
    console.error('DramaPops Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'DRAMAPOPS' });
  }
});

// --- DramaNova Routes ---
const dramanovaBase = process.env.DRAMANOVA_BASE_URL || 'https://captain.sapimu.au/dramanova';
const dramanovaToken = process.env.DRAMANOVA_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/dramanova/home', async (req, res) => {
  try {
    const { lang = 'in', limit = 30, page = 1 } = req.query;
    const response = await axios.get(`${dramanovaBase}/api/v1/dramas`, {
      params: { lang, size: limit, page },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    const list = response.data?.rows || [];
    res.json({ dramas: list, platform: 'DRAMANOVA' });
  } catch (error: any) {
    console.error('DramaNova Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramanova/search', async (req, res) => {
  try {
    const { q = '', lang = 'in', limit = 30, page = 1 } = req.query;
    const response = await axios.get(`${dramanovaBase}/api/v1/search`, {
      params: { q, lang, size: limit, page },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    const list = response.data?.rows || [];
    res.json({ dramas: list, platform: 'DRAMANOVA' });
  } catch (error: any) {
    console.error('DramaNova Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramanova/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'in' } = req.query;
    const response = await axios.get(`${dramanovaBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    const seriesData = response.data || {};
    const episodes = seriesData.episodes || [];
    
    const list = episodes.map((ep: any) => ({
      id: ep.id || ep.number,
      title: `Episode ${ep.number}`,
      episNum: ep.number,
      cover: seriesData.cover || '',
      isVip: !ep.free
    }));

    res.json({ data: { list, series: seriesData }, platform: 'DRAMANOVA' });
  } catch (error: any) {
    console.error('DramaNova Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'DRAMANOVA' });
  }
});

app.get('/api/dramanova/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = '720p', lang = 'in' } = req.query;
    
    const dramaRes = await axios.get(`${dramanovaBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    const episodes = dramaRes.data?.episodes || [];
    const episode = episodes.find((e: any) => String(e.number) === String(ep) || String(e.id) === String(ep));
    if (!episode || !episode.fileId) {
      return res.json({ data: { url: '' }, error: 'Episode or fileId not found' });
    }

    const videoRes = await axios.get(`${dramanovaBase}/api/video`, {
      params: { id: episode.fileId },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    
    const videoData = videoRes.data || {};
    const videos = videoData.videos || [];
    
    let streamUrl = '';
    const qualVideo = videos.find((v: any) => v.definition === quality || v.quality === quality) || videos[0];
    if (qualVideo) {
      streamUrl = qualVideo.main_url || qualVideo.backup_url || '';
    }

    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=DRAMANOVA`;
      res.json({ data: { url: proxiedUrl }, platform: 'DRAMANOVA' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('DramaNova Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'DRAMANOVA' });
  }
});

app.get('/api/dramanova/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'in' } = req.query;
    const dramaRes = await axios.get(`${dramanovaBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramanovaToken}` }
    });
    const episodes = dramaRes.data?.episodes || [];
    const episode = episodes.find((e: any) => String(e.number) === String(ep) || String(e.id) === String(ep));
    
    if (episode && episode.subtitles && episode.subtitles.length > 0) {
      const sub = episode.subtitles.find((s:any) => s.lang === lang) || episode.subtitles[0];
      if (sub && (sub.url || sub.label)) {
         const subUrl = sub.url || sub.label;
         const reqHost = req.headers.host || '127.0.0.1:5001';
         const proxiedUrl = `http://${reqHost}/api/proxy/subtitle?url=${encodeURIComponent(subUrl)}`;
         const proxyRes = await axios.get(proxiedUrl);
         return res.json(proxyRes.data);
      }
    }
    res.json({ data: { list: [] }, platform: 'DRAMANOVA' });
  } catch (error: any) {
    console.error('DramaNova Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'DRAMANOVA' });
  }
});

// --- DramaBite Routes ---
const dramabiteBase = process.env.DRAMABITE_BASE_URL || 'https://captain.sapimu.au/dramabite';
const dramabiteToken = process.env.DRAMABITE_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/dramabite/home', async (req, res) => {
  try {
    const { lang = 'id', limit = 30 } = req.query;
    const response = await axios.get(`${dramabiteBase}/api/v1/dramas`, {
      params: { lang, page: 0 },
      headers: { Authorization: `Bearer ${dramabiteToken}` }
    });
    const list = Array.isArray(response.data) ? response.data : [];
    res.json({ dramas: list, platform: 'DRAMABITE' });
  } catch (error: any) {
    console.error('DramaBite Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramabite/search', async (req, res) => {
  try {
    const { q = '', lang = 'id', limit = 30 } = req.query;
    const response = await axios.get(`${dramabiteBase}/api/v1/search`, {
      params: { q, lang, limit },
      headers: { Authorization: `Bearer ${dramabiteToken}` }
    });
    const list = Array.isArray(response.data) ? response.data : [];
    res.json({ dramas: list, platform: 'DRAMABITE' });
  } catch (error: any) {
    console.error('DramaBite Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramabite/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${dramabiteBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${dramabiteToken}` }
    });
    const seriesData = response.data || {};
    const episodes = seriesData.episodes || [];
    
    const list = episodes.map((ep: any) => ({
      id: ep.id || ep.number,
      title: ep.title || `Episode ${ep.number}`,
      episNum: ep.number,
      cover: seriesData.cover || '',
      isVip: !ep.free
    }));

    res.json({ data: { list, series: seriesData }, platform: 'DRAMABITE' });
  } catch (error: any) {
    console.error('DramaBite Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'DRAMABITE' });
  }
});

app.get('/api/dramabite/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = 'default', lang = 'id' } = req.query;
    
    const response = await axios.get(`${dramabiteBase}/api/v1/drama/${id}/episode/${ep}`, {
      params: { lang, quality },
      headers: { Authorization: `Bearer ${dramabiteToken}` }
    });
    
    const epData = response.data || {};
    const streamUrl = epData.video || epData.url || '';

    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=DRAMABITE`;
      res.json({ data: { url: proxiedUrl }, platform: 'DRAMABITE' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('DramaBite Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'DRAMABITE' });
  }
});

app.get('/api/dramabite/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'DRAMABITE' });
});

// --- FlexTV Routes ---
const flextvBase = process.env.FLEXTV_BASE_URL || 'https://captain.sapimu.au/flextv';
const flextvToken = process.env.FLEXTV_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/flextv/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const response = await axios.get(`${flextvBase}/api/v1/tabs/1`, {
      params: { lang, page },
      headers: { Authorization: `Bearer ${flextvToken}` }
    });
    const floors = response.data?.data?.floor || [];
    let list: any[] = [];
    for (const f of floors) {
      if (Array.isArray(f.series_list)) list = list.concat(f.series_list);
    }
    res.json({ dramas: list, platform: 'FLEXTV' });
  } catch (error: any) {
    console.error('FlexTV Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/flextv/search', async (req, res) => {
  try {
    const { q = '', lang = 'id', page = 1 } = req.query;
    const response = await axios.get(`${flextvBase}/api/v1/search`, {
      params: { q, lang, page },
      headers: { Authorization: `Bearer ${flextvToken}` }
    });
    const list = response.data?.data?.list || [];
    res.json({ dramas: list, platform: 'FLEXTV' });
  } catch (error: any) {
    console.error('FlexTV Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/flextv/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${flextvBase}/api/v1/series/${id}/episodes`, {
      params: { lang },
      headers: { Authorization: `Bearer ${flextvToken}` }
    });
    
    const epData = response.data?.data || {};
    const seriesData = epData.detail || {};
    const epsList = epData.list || [];
    
    const list = epsList.map((ep: any) => ({
      id: ep.id,
      title: `Episode ${ep.series_no || ep.id}`,
      episNum: ep.id,
      cover: seriesData.cover || ep.cover || '',
      isVip: ep.is_charge === 1
    }));

    res.json({ data: { list, series: seriesData }, platform: 'FLEXTV' });
  } catch (error: any) {
    console.error('FlexTV Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'FLEXTV' });
  }
});

app.get('/api/flextv/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${flextvBase}/api/v1/play/${id}/${ep}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${flextvToken}` }
    });
    
    const playData = response.data?.data || {};
    const streamUrl = playData.video_url || '';
    
    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=FLEXTV`;
      res.json({ data: { url: proxiedUrl }, platform: 'FLEXTV' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('FlexTV Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'FLEXTV' });
  }
});

app.get('/api/flextv/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'FLEXTV' });
});

// --- iDrama Routes ---
const idramaBase = process.env.IDRAMA_BASE_URL || 'https://captain.sapimu.au/idrama';
const idramaToken = process.env.IDRAMA_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/idrama/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const response = await axios.get(`${idramaBase}/api/v1/popular`, {
      params: { page, limit: 30, lang },
      headers: { Authorization: `Bearer ${idramaToken}` }
    });
    const list = response.data?.short_plays || [];
    res.json({ dramas: list, platform: 'IDRAMA' });
  } catch (error: any) {
    console.error('iDrama Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/idrama/search', async (req, res) => {
  try {
    const { q, page = 1, lang = 'id' } = req.query;
    const response = await axios.get(`${idramaBase}/api/v1/search`, {
      params: { q, page_size: 20, lang },
      headers: { Authorization: `Bearer ${idramaToken}` }
    });
    const list = response.data?.results || [];
    res.json({ dramas: list, platform: 'IDRAMA' });
  } catch (error: any) {
    console.error('iDrama Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/idrama/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${idramaBase}/api/v1/drama/${id}`, {
      params: { lang },
      headers: { Authorization: `Bearer ${idramaToken}` }
    });
    
    const epList = response.data?.episode_list || [];
    const list = epList.map((ep: any) => ({
      id: ep.episode_id,
      title: `Episode ${ep.episode_order}`,
      episNum: ep.episode_order,
      cover: ep.episode_cover || '',
      isVip: ep.episode_status === 1 || !ep.play_url
    }));

    res.json({ data: { list, series: response.data }, platform: 'IDRAMA' });
  } catch (error: any) {
    console.error('iDrama Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'IDRAMA' });
  }
});

app.get('/api/idrama/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    let epOrder = parseInt(ep);
    
    if (epOrder > 10000) { 
      try {
        const detailRes = await axios.get(`${idramaBase}/api/v1/drama/${id}`, {
          params: { lang: 'id' },
          headers: { Authorization: `Bearer ${idramaToken}` }
        });
        const list = detailRes.data?.episode_list || [];
        const match = list.find((i: any) => String(i.episode_id) === String(ep));
        if (match) epOrder = match.episode_order;
        else epOrder = 1;
      } catch (e) {
        epOrder = 1;
      }
    }
    
    const response = await axios.post(`${idramaBase}/api/v1/unlock/${id}/${epOrder}/${epOrder}`, {}, {
      headers: { Authorization: `Bearer ${idramaToken}` }
    });
    
    const epData = response.data?.episodes?.[0]?.data || {};
    
    let streamUrl = '';
    if (epData.play_info_list) {
      const q720 = epData.play_info_list.find((q: any) => q.definition === '720p');
      if (q720 && q720.play_url) streamUrl = q720.play_url;
      else if (epData.play_info_list[0]?.play_url) streamUrl = epData.play_info_list[0].play_url;
    }
    if (!streamUrl) streamUrl = epData.play_url || '';
    
    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=IDRAMA`;
      res.json({ data: { url: proxiedUrl }, platform: 'IDRAMA' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('iDrama Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'IDRAMA' });
  }
});

app.get('/api/idrama/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'IDRAMA' });
});

// --- GoodShort Routes ---
const goodshortBase = process.env.GOODSHORT_BASE_URL || 'https://goodshort.dramabos.my.id';
const goodshortToken = process.env.GOODSHORT_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

// In-memory cache for GoodShort rawurl responses (bookId -> { videoKey, episodes, fetchedAt })
const gsBookCache: Record<string, { videoKey: string | null; episodes: Record<string, string>; fetchedAt: number }> = {};
const GS_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

async function loadGoodshortBook(bookId: string, lang: string = 'in') {
  const now = Date.now();
  if (gsBookCache[bookId] && now - gsBookCache[bookId].fetchedAt < GS_CACHE_TTL) {
    return gsBookCache[bookId];
  }
  const url = `${goodshortBase}/rawurl/${bookId}?lang=${lang}&q=720p&code=${goodshortToken}`;
  const res = await axios.get(url, { timeout: 15000 });
  const data = res.data?.data;
  if (!data) throw new Error('GoodShort rawurl returned empty data');

  const episodes: Record<string, string> = {};
  for (const ep of (data.episodes || [])) {
    if (ep.id != null && ep.m3u8) episodes[String(ep.id)] = ep.m3u8;
  }
  const entry = { videoKey: data.videoKey || null, episodes, fetchedAt: now };
  gsBookCache[bookId] = entry;
  console.log(`[GoodShort] Loaded book ${data.bookName || bookId}: ${Object.keys(episodes).length} eps, key: ${entry.videoKey ? entry.videoKey.slice(0,8)+'...' : 'none'}`);
  return entry;
}

app.get('/api/goodshort/home', async (req, res) => {
  const { page = 1, lang = 'in' } = req.query;
  const cacheKey = `goodshort_home_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${goodshortBase}/home`, {
      params: { lang, channel: -1, page, size: 20 }
    });
    const blocks = response.data?.data?.records || [];
    let list: any[] = [];
    for (const b of blocks) {
      if (Array.isArray(b.items)) list = list.concat(b.items);
    }
    const mapped = list.map((d: any) => {
      const rawPoster = d.coverWap || d.coverPlays || d.cover || d.image || '';
      const poster = rawPoster ? `/api/proxy/image?url=${encodeURIComponent(rawPoster)}` : '';
      return {
        id: d.bookId,
        title: d.bookName,
        poster,
        episodes: d.chapterCount || d.totalChapter || d.lastChapterId || 0,
        likes: String(d.viewCount || d.likeNum || 0),
        platform: 'GOODSHORT'
      };
    });
    const result = { dramas: mapped, platform: 'GOODSHORT' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('GoodShort Home error:', error.message);
    res.json({ dramas: [], platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/search', async (req, res) => {
  const { q = '', lang = 'in', page = 1 } = req.query;
  const cacheKey = `goodshort_search_${q}_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${goodshortBase}/search`, {
      params: { lang, q, page, size: 15, code: goodshortToken }
    });
    const list = response.data?.data?.searchResult?.records || response.data?.data?.list || [];
    const mapped = list.map((d: any) => {
      const rawPoster = d.coverWap || d.coverPlays || d.cover || d.image || '';
      const poster = rawPoster ? `/api/proxy/image?url=${encodeURIComponent(rawPoster)}` : '';
      return {
        id: d.bookId,
        title: d.bookName,
        poster,
        episodes: d.chapterCount || d.totalChapter || d.lastChapterId || 0,
        likes: String(d.viewCount || d.likeNum || 0),
        platform: 'GOODSHORT'
      };
    });
    const result = { dramas: mapped, platform: 'GOODSHORT' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('GoodShort Search error:', error.message);
    res.json({ dramas: [], platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'in' } = req.query;
  try {
    const response = await axios.get(`${goodshortBase}/chapters/${id}`, {
      params: { lang, code: goodshortToken }
    });
    const data = response.data?.data;
    const chapters = data?.chapterList || data?.list || (Array.isArray(data) ? data : []);

    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.json({ data: { list: [], series: {} }, platform: 'GOODSHORT' });
    }

    const list = chapters.map((c: any) => ({
      id: String(c.chapterId || c.id),
      number: Number(c.chapterId || c.id),
      title: c.chapterName || c.name || `Episode ${c.chapterId || c.id}`
    }));

    res.json({ data: { list, series: { id, title: '', poster: '', episodes: list.length } }, platform: 'GOODSHORT' });
  } catch (error: any) {
    console.error('GoodShort Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  try {
    // Load (or use cached) rawurl data for this book
    await loadGoodshortBook(id, 'in');
    const reqHost = req.get('host') || '127.0.0.1:5001';
    // Point player to our m3u8 proxy which handles AES key rewrite
    const proxyUrl = `http://${reqHost}/api/goodshort/proxy/m3u8/${ep}?bookId=${id}`;
    res.json({ data: { url: proxyUrl }, platform: 'GOODSHORT' });
  } catch (error: any) {
    console.error('GoodShort Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'GOODSHORT', error: error.message });
  }
});

app.get('/api/goodshort/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'GOODSHORT' });
});

// ── GoodShort M3U8 Proxy ──────────────────────────────────────────────────────
app.get('/api/goodshort/proxy/m3u8/:chapterId', async (req, res) => {
  const { chapterId } = req.params;
  const bookId = req.query.bookId as string;

  try {
    // Ensure book is loaded
    if (bookId && (!gsBookCache[bookId] || !gsBookCache[bookId].episodes[chapterId])) {
      await loadGoodshortBook(bookId, 'in');
    }

    const book = bookId ? gsBookCache[bookId] : null;
    const m3u8Url = book?.episodes[chapterId];

    if (!m3u8Url) {
      console.error(`[GoodShort Proxy] m3u8 not found for chapterId=${chapterId}`);
      return res.status(404).send('Episode not found in cache. Try reloading.');
    }

    const r = await axios.get(m3u8Url, {
      headers: { 'User-Agent': 'okhttp/4.10.0' },
      timeout: 10000,
      responseType: 'text'
    });

    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/'));
    let content: string = r.data;

    // Replace local AES key URI with inline base64 data URI
    if (book?.videoKey) {
      content = content.replace(
        /URI="local:\/\/[^"]*"/g,
        `URI="data:text/plain;base64,${book.videoKey}"`
      );
    }

    // Rewrite .ts segment URLs through our proxy
    const reqHost = req.get('host') || '127.0.0.1:5001';
    const lines = content.split('\n').map((line: string) => {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith('#') && stripped.endsWith('.ts')) {
        const tsUrl = stripped.startsWith('http') ? stripped : `${baseUrl}/${stripped}`;
        return `http://${reqHost}/api/goodshort/proxy/ts?url=${encodeURIComponent(tsUrl)}`;
      }
      return line;
    });

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(lines.join('\n'));
  } catch (e: any) {
    console.error('[GoodShort Proxy m3u8] Error:', e.message);
    res.status(502).send('Failed to fetch m3u8 from CDN');
  }
});

// ── GoodShort TS Segment Proxy ────────────────────────────────────────────────
app.get('/api/goodshort/proxy/ts', async (req, res) => {
  const tsUrl = req.query.url as string;
  if (!tsUrl) return res.status(400).send('Missing url parameter');

  try {
    const r = await axios.get(tsUrl, {
      headers: { 'User-Agent': 'okhttp/4.10.0' },
      responseType: 'stream',
      timeout: 15000
    });
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    r.data.pipe(res);
  } catch (e: any) {
    console.error('[GoodShort Proxy ts] Error:', e.message);
    res.status(502).send('Failed to fetch segment');
  }
});


// --- DramaWave Routes ---
const dramawaveBase = process.env.DRAMAWAVE_BASE_URL || 'https://captain.sapimu.au/dramawave';
const dramawaveToken = process.env.DRAMAWAVE_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/dramawave/home', async (req, res) => {
  try {
    const { tab = 'popular', page = 1 } = req.query;
    const response = await axios.get(`${dramawaveBase}/api/v1/feed/${tab}`, {
      params: { page, lang: 'id-ID' },
      headers: { Authorization: `Bearer ${dramawaveToken}` }
    });
    
    // DramaWave returns nested modules in data.items
    const modules = response.data?.data?.items || [];
    const flattened: any[] = [];
    modules.forEach((mod: any) => {
      if (mod.items && Array.isArray(mod.items)) {
        mod.items.forEach((item: any) => flattened.push(item));
      }
    });

    res.json({ dramas: flattened, platform: 'DRAMAWAVE' });
  } catch (error: any) {
    console.error('DramaWave Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramawave/search', async (req, res) => {
  try {
    const { q } = req.query;
    const response = await axios.get(`${dramawaveBase}/api/v1/search`, {
      params: { q, lang: 'id-ID' },
      headers: { Authorization: `Bearer ${dramawaveToken}` }
    });
    const list = response.data?.data?.list || response.data?.list || [];
    res.json({ dramas: list, platform: 'DRAMAWAVE' });
  } catch (error: any) {
    console.error('DramaWave Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/dramawave/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`${dramawaveBase}/api/v1/dramas/${id}`, {
      params: { lang: 'id-ID' },
      headers: { Authorization: `Bearer ${dramawaveToken}` }
    });
    const seriesData = response.data?.data?.info || response.data?.data || {};
    const chapters = seriesData.episode_list || [];
    
    const list = chapters.map((ep: any, idx: number) => ({
      id: String(ep.id || idx + 1),
      title: ep.name || `Episode ${idx + 1}`,
      episNum: idx + 1,
      cover: ep.cover || seriesData.cover || '',
      isVip: ep.is_vip || (idx >= (seriesData.pay_index || 5))
    }));

    res.json({ data: { list, series: seriesData }, platform: 'DRAMAWAVE' });
  } catch (error: any) {
    console.error('DramaWave Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'DRAMAWAVE' });
  }
});

app.get('/api/dramawave/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    console.log(`[DramaWave] Stream Request: id=${id}, ep=${ep}`);
    const response = await axios.get(`${dramawaveBase}/api/v1/dramas/${id}/play/${ep}`, {
      params: { lang: 'id-ID' },
      headers: { Authorization: `Bearer ${dramawaveToken}` }
    });
    const streamData = response.data?.data || response.data || {};
    const streamUrl = streamData.url || streamData.m3u8 || streamData.m3u8_url || streamData.external_audio_h264_m3u8 || '';
    
    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=DRAMAWAVE`;
      res.json({ data: { url: proxiedUrl }, platform: 'DRAMAWAVE' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('DramaWave Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'DRAMAWAVE' });
  }
});

app.get('/api/dramawave/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const response = await axios.get(`${dramawaveBase}/api/v1/dramas/${id}/play/${ep}`, {
      params: { lang: 'id-ID' },
      headers: { Authorization: `Bearer ${dramawaveToken}` }
    });
    const data = response.data?.data || response.data || {};
    const subs = data.subtitle_list || data.subtitles || data.subs || [];
    
    // Improved Indonesian language detection
    const targetSub = subs.find((s: any) => {
      const l = (s.language || s.lang || s.code || '').replace(/_/g, '-');
      return l === 'id-ID' || l === 'id-id' || l.toLowerCase() === 'id' || l.toLowerCase() === 'in' || l.toLowerCase() === 'ind' || l.toLowerCase().includes('indonesia');
    }) || subs.find((s: any) => {
      const l = (s.language || s.lang || '').toLowerCase();
      return l === 'en' || l === 'en-us' || l.includes('english');
    }) || subs[0];
    
    if (targetSub) {
      const originalUrl = targetSub.vtt || targetSub.subtitle || targetSub.url || targetSub.subtitle_url || '';
      console.log(`[DramaWave] Selected Subtitle (${targetSub.language || targetSub.lang}): ${originalUrl}`);
      const list = await standardizeSubtitles(originalUrl);
      return res.json({ data: { list }, platform: 'DRAMAWAVE' });
    }

    res.json({ data: { list: [] }, platform: 'DRAMAWAVE' });
  } catch (error: any) {
    console.error('DramaWave Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'DRAMAWAVE' });
  }
});

app.post('/api/admin/system/update', (req, res) => {
  const { type = 'quick' } = req.body;
  console.log(`[System] ${type.toUpperCase()} update triggered from Admin Panel`);
  
  // Determine command based on type
  // Quick: Pull + Restart Backend
  // Full: Pull + Rebuild Frontend + Restart All
  let command = 'git pull && pm2 restart all';
  if (type === 'full') {
    command = 'git pull && cd ../../stellar-streaming && npm run build && cd ../nexusos/server && pm2 restart all';
  }
  
  exec(command, { cwd: __dirname }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Update Error: ${error.message}`);
      return res.status(500).json({ success: false, error: error.message, details: stderr });
    }
    res.json({ success: true, output: stdout });
  });
});

// --- ShortBox API Routes ---
const shortboxBase = process.env.SHORTBOX_BASE_URL || 'https://captain.sapimu.au/shortbox';
const shortboxToken = process.env.SHORTBOX_TOKEN || '5cf419a4c7fb1c8585314b9f797bf77e7b10a705f32c91aac65b901559780e12';

app.get('/api/shortbox/home', async (req, res) => {
  try {
    const { page = 1, page_size = 100 } = req.query;
    console.log('[ShortBox] Home Request:', { page, page_size });
    
    const response = await axios.get(`${shortboxBase}/api/list`, {
      params: { page, page_size, sort_type: 1, languages: 'id' },
      headers: { Authorization: `Bearer ${shortboxToken}` }
    });
    
    // ShortBox list can be in data.data.data or data.data.list
    let list = response.data?.data?.data || response.data?.data?.list || response.data?.data || [];
    if (!Array.isArray(list)) list = [];

    // Fallback to EN if ID is empty
    if (list.length === 0) {
      console.log('[ShortBox] ID list empty, trying EN fallback...');
      const fallback = await axios.get(`${shortboxBase}/api/list`, {
        params: { page, page_size, sort_type: 1, languages: 'en' },
        headers: { Authorization: `Bearer ${shortboxToken}` }
      });
      list = fallback.data?.data?.data || fallback.data?.data?.list || fallback.data?.data || [];
      if (!Array.isArray(list)) list = [];
    }

    console.log('[ShortBox] Home Status:', response.status, 'Count:', list.length);
    res.json({ dramas: list, platform: 'SHORTBOX' });
  } catch (error: any) {
    console.error('ShortBox Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortbox/search', async (req, res) => {
  try {
    const { q = '', page = 1 } = req.query;
    console.log('[ShortBox] Search Request:', { q, page });
    const response = await axios.get(`${shortboxBase}/api/search`, {
      params: { q, page, page_size: 20, is_fuzzy: 1, languages: 'id' },
      headers: { Authorization: `Bearer ${shortboxToken}` }
    });
    console.log('[ShortBox] Search Status:', response.status, 'Count:', response.data?.data?.list?.length);
    // Search also returns data.list
    res.json({ dramas: response.data?.data?.list || [], platform: 'SHORTBOX' });
  } catch (error: any) {
    console.error('ShortBox Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortbox/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const detailRes = await axios.get(`${shortboxBase}/api/detail/${id}`, {
      params: { languages: 'id' },
      headers: { Authorization: `Bearer ${shortboxToken}` }
    });
    const epRes = await axios.get(`${shortboxBase}/api/episodes/${id}`, {
      params: { index: 1, count: 200, languages: 'id' },
      headers: { Authorization: `Bearer ${shortboxToken}` }
    });
    
    const epList = epRes.data?.data?.list || [];
    const list = epList.map((ep: any) => ({
      id: ep.episode_index,
      title: `Episode ${ep.episode_index}`,
      episNum: ep.episode_index,
      cover: detailRes.data?.data?.cover_image || '',
      isVip: ep.status === 20
    }));
    res.json({ data: { list, series: detailRes.data?.data }, platform: 'SHORTBOX' });
  } catch (error: any) {
    console.error('ShortBox Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'SHORTBOX' });
  }
});

app.get('/api/shortbox/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { quality = 'high' } = req.query;
    const response = await axios.get(`${shortboxBase}/api/stream/${id}/${ep}`, {
      params: { quality, languages: 'id' },
      headers: { Authorization: `Bearer ${shortboxToken}` }
    });
    
    let streamUrl = response.data?.data?.stream_url || '';
    if (streamUrl) {
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=SHORTBOX`;
      res.json({ data: { url: proxiedUrl, drm: response.data?.data?.drm }, platform: 'SHORTBOX' });
    } else {
      res.json({ data: { url: '' }, error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('ShortBox Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'SHORTBOX' });
  }
});

app.get('/api/shortbox/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'SHORTBOX' });
});

// --- Velolo Routes ---
const veloloBase = process.env.VELOLO_BASE_URL || 'https://velolo.dramabos.my.id';

app.get('/api/velolo/home', async (req, res) => {
  try {
    const { page = 1, page_size = 100, limit } = req.query;
    const finalSize = limit || page_size;
    console.log('[Velolo] Home Request:', { page, page_size: finalSize });
    const response = await axios.get(`${veloloBase}/home`, {
      params: { lang: 'id', page, page_size: finalSize }
    });
    console.log('[Velolo] Home Response Status:', response.status);
    const list = response.data?.data || response.data || [];
    console.log('[Velolo] Home List Length:', Array.isArray(list) ? list.length : 'Not an array');
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'VELOLO' });
  } catch (error: any) {
    console.error('Velolo Home error:', error.message);
    res.json({ dramas: [], platform: 'VELOLO', error: error.message });
  }
});

app.get('/api/velolo/search', async (req, res) => {
  try {
    const { q, page = 1, page_size = 100, limit } = req.query;
    const finalSize = limit || page_size;
    const response = await axios.get(`${veloloBase}/search`, {
      params: { q, lang: 'id', page, page_size: finalSize }
    });
    const list = response.data?.data || response.data || [];
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'VELOLO' });
  } catch (error: any) {
    console.error('Velolo Search error:', error.message);
    res.json({ dramas: [], platform: 'VELOLO', error: error.message });
  }
});

app.get('/api/velolo/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`${veloloBase}/drama/${id}`, {
      params: { lang: 'id' }
    });
    const seriesData = response.data?.data || response.data || {};
    const chapters = seriesData.episodes || seriesData.episode_list || [];
    
    // Standardize episodes
    const formatted = chapters.map((ep: any, idx: number) => ({
      id: ep.id || `${id}-${idx + 1}`,
      num: ep.num || ep.episode_index || idx + 1,
      title: ep.title || `Episode ${ep.num || idx + 1}`,
      url: ep.url || ep.video_url || '',
      subtitle_list: ep.subtitle_list || ep.subtitles || []
    }));

    res.json({ data: { list: formatted, series: seriesData }, platform: 'VELOLO' });
  } catch (error: any) {
    console.error('Velolo Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'VELOLO' });
  }
});

app.get('/api/velolo/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const response = await axios.get(`${veloloBase}/drama/${id}`, {
      params: { lang: 'id' }
    });
    const seriesData = response.data?.data || response.data || {};
    const chapters = seriesData.episodes || seriesData.episode_list || [];
    const target = chapters.find((c: any) => String(c.id) === ep || String(c.num) === ep || String(c.episode_index) === ep) || chapters[0];
    
    if (target) {
      const streamUrl = target.url || target.video_url || '';
      res.json({ data: { url: streamUrl }, platform: 'VELOLO' });
    } else {
      res.json({ data: { url: '' }, platform: 'VELOLO' });
    }
  } catch (error: any) {
    console.error('Velolo Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'VELOLO' });
  }
});

app.get('/api/velolo/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const response = await axios.get(`${veloloBase}/drama/${id}`, {
      params: { lang: 'id' }
    });
    const seriesData = response.data?.data || response.data || {};
    const chapters = seriesData.episodes || seriesData.episode_list || [];
    const target = chapters.find((c: any) => String(c.id) === ep || String(c.num) === ep || String(c.episode_index) === ep) || chapters[0];
    
    if (target) {
      const subs = target.subtitle_list || target.subtitles || [];
      const targetSub = subs.find((s: any) => {
        const l = (s.language || s.lang || s.code || '').toLowerCase().replace(/_/g, '-');
        return l === 'id-id' || l === 'id' || l === 'in' || l.includes('indonesia');
      }) || subs[0];
      
      if (targetSub) {
        const originalUrl = targetSub.vtt || targetSub.subtitle || targetSub.url || '';
        const list = await standardizeSubtitles(originalUrl);
        return res.json({ data: { list }, platform: 'VELOLO' });
      }
    }
    res.json({ data: { list: [] }, platform: 'VELOLO' });
  } catch (error: any) {
    console.error('Velolo Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'VELOLO' });
  }
});

app.get('/api/velolo/languages', async (req, res) => {
  try {
    const response = await axios.get(`${veloloBase}/languages`);
    res.json(response.data);
  } catch (error: any) {
    res.json({ data: [] });
  }
});

// --- HappyShort API Routes ---
const happyshortBase = 'https://happyshort.dramabos.my.id/api/hs';
const happyshortToken = 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/happyshort/home', async (req, res) => {
  try {
    const { page = 1, size = 100, lang = 'id', limit } = req.query;
    const finalSize = limit || size;
    const response = await axios.get(`${happyshortBase}/home`, {
      params: { page, size: finalSize, lang }
    });
    const list = response.data?.data || response.data?.rows || response.data || [];
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'HAPPYSHORT' });
  } catch (error: any) {
    console.error('HappyShort Home error:', error.message);
    res.json({ dramas: [], platform: 'HAPPYSHORT', error: error.message });
  }
});

app.get('/api/happyshort/search', async (req, res) => {
  try {
    const { q, lang = 'id', page = 1, size = 100, limit } = req.query;
    const finalSize = limit || size;
    const response = await axios.get(`${happyshortBase}/search`, {
      params: { q, lang, page, size: finalSize }
    });
    const list = response.data?.data || response.data?.rows || response.data || [];
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'HAPPYSHORT' });
  } catch (error: any) {
    console.error('HappyShort Search error:', error.message);
    res.json({ dramas: [], platform: 'HAPPYSHORT', error: error.message });
  }
});

app.get('/api/happyshort/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${happyshortBase}/episodes`, {
      params: { id, lang }
    });
    const chapters = response.data?.data || response.data?.list || response.data || [];
    
    const formatted = chapters.map((ep: any, idx: number) => ({
      id: ep.id || ep.episode_id || `${id}-${idx + 1}`,
      num: ep.num || ep.episode_index || ep.order || idx + 1,
      title: ep.title || ep.name || `Episode ${idx + 1}`,
      url: '', // Will be fetched via stream route
      subtitle_list: []
    }));

    res.json({ data: { list: formatted, series: { id } }, platform: 'HAPPYSHORT' });
  } catch (error: any) {
    console.error('HappyShort Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'HAPPYSHORT' });
  }
});

app.get('/api/happyshort/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    
    // Using the play endpoint which returns the actual stream URL
    const response = await axios.get(`${happyshortBase}/play`, {
      params: { id, ep, lang, code: happyshortToken }
    });
    
    const streamUrl = response.data?.data?.url || response.data?.url || '';
    res.json({ data: { url: streamUrl }, platform: 'HAPPYSHORT' });
  } catch (error: any) {
    console.error('HappyShort Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'HAPPYSHORT' });
  }
});

app.get('/api/happyshort/languages', async (req, res) => {
  try {
    const response = await axios.get(`${happyshortBase}/languages`);
    res.json(response.data);
  } catch (error: any) {
    res.json({ data: [] });
  }
});

// --- RapidTV API Routes ---
const rapidtvBase = 'https://rapidtv.dramabos.my.id/api';
const rapidtvToken = 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/rapidtv/home', async (req, res) => {
  try {
    const { page = 1, limit = 100, lang = 'id' } = req.query;
    const response = await axios.get(`${rapidtvBase}/drama/list`, {
      params: { page, limit, lang }
    });
    // RapidTV can return dramas in many nested structures
    const list = response.data?.data?.rows || 
                 response.data?.data?.list || 
                 response.data?.data?.items || 
                 response.data?.data || 
                 response.data?.rows || 
                 response.data?.list || 
                 response.data || [];
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'RAPIDTV' });
  } catch (error: any) {
    console.error('RapidTV Home error:', error.message);
    res.json({ dramas: [], platform: 'RAPIDTV', error: error.message });
  }
});

app.get('/api/rapidtv/search', async (req, res) => {
  try {
    const { q, lang = 'id', page = 1, limit = 100 } = req.query;
    const response = await axios.get(`${rapidtvBase}/search`, {
      params: { q, lang, page, limit }
    });
    const list = response.data?.data?.rows || 
                 response.data?.data?.list || 
                 response.data?.data?.items || 
                 response.data?.data || 
                 response.data?.rows || 
                 response.data?.list || 
                 response.data || [];
    res.json({ dramas: Array.isArray(list) ? list : [], platform: 'RAPIDTV' });
  } catch (error: any) {
    console.error('RapidTV Search error:', error.message);
    res.json({ dramas: [], platform: 'RAPIDTV', error: error.message });
  }
});

app.get('/api/rapidtv/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${rapidtvBase}/drama/${id}`, {
      params: { lang }
    });
    
    const dramaData = response.data?.data || response.data || {};
    const chapters = dramaData.episodes || dramaData.episode_list || [];
    
    const formatted = chapters.map((ep: any, idx: number) => ({
      id: ep.id || ep.episode_id || `${id}-${idx + 1}`,
      num: ep.num || ep.episode_index || ep.order || idx + 1,
      title: ep.title || ep.name || `Episode ${idx + 1}`,
      url: ep.url || ep.video_url || '',
      subtitle_list: ep.subtitle_list || ep.subtitles || []
    }));

    res.json({ data: { list: formatted, series: dramaData }, platform: 'RAPIDTV' });
  } catch (error: any) {
    console.error('RapidTV Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'RAPIDTV' });
  }
});

app.get('/api/rapidtv/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`${rapidtvBase}/drama/${id}/${ep}`, {
      params: { lang, token: rapidtvToken }
    });
    
    const streamUrl = response.data?.data?.url || response.data?.url || '';
    res.json({ data: { url: streamUrl }, platform: 'RAPIDTV' });
  } catch (error: any) {
    console.error('RapidTV Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'RAPIDTV' });
  }
});

app.get('/api/rapidtv/languages', async (req, res) => {
  try {
    const response = await axios.get(`${rapidtvBase}/languages`);
    res.json(response.data);
  } catch (error: any) {
    res.json({ data: [] });
  }
});

// --- Adult (18+) Routes (CubeTV API) ---
const adultBase = process.env.ADULT_BASE_URL || 'https://cubetv.dramabos.my.id';
const adultToken = process.env.ADULT_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/adult/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const p = Number(page);
    const response = await axios.get(`${adultBase}/api/home`, {
      params: { code: adultToken, lang, page: p }
    });
    
    // CubeTV returns rows of modules, each with a videos array
    const rows = response.data?.rows || [];
    let list: any[] = [];
    for (const row of rows) {
      if (Array.isArray(row.videos)) {
        list = list.concat(row.videos);
      }
    }
    
    // Deduplicate by videoid
    const uniqueList = Array.from(new Map(list.map(item => [item.videoid, item])).values());
    
    res.json({ dramas: uniqueList, platform: 'ADULT' });
  } catch (error: any) {
    console.error('Adult Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/adult/search', async (req, res) => {
  try {
    const { q = '', lang = 'id', page = 1 } = req.query;
    const response = await axios.get(`${adultBase}/api/search`, {
      params: { code: adultToken, lang, q, page }
    });
    
    const list = response.data?.rows || response.data?.list || [];
    res.json({ dramas: list, platform: 'ADULT' });
  } catch (error: any) {
    console.error('Adult Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/adult/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    
    // Get detail first for series info
    const detailRes = await axios.get(`${adultBase}/api/detail/${id}`, {
      params: { code: adultToken, lang }
    });
    const seriesData = detailRes.data || {};

    const response = await axios.get(`${adultBase}/api/episodes/${id}`, {
      params: { code: adultToken, lang }
    });
    
    const epRows = response.data?.rows || [];
    const list = epRows.map((ep: any) => {
      // Find the best quality URL (prefer sd or first available)
      const streamObj = ep.videoUrls?.find((v: any) => v.quality === 'sd') || ep.videoUrls?.[0];
      const streamUrl = streamObj?.url || '';
      
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = streamUrl ? `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=ADULT` : '';

      return {
        id: ep.episodeid,
        title: ep.episodeTitle || `Episode ${ep.episodeNumber}`,
        episNum: ep.episodeNumber,
        cover: seriesData.cover || '',
        isVip: ep.lockStatus === 1,
        streamUrl: proxiedUrl // Provide direct stream URL to frontend
      };
    });

    res.json({ data: { list, series: seriesData }, platform: 'ADULT' });
  } catch (error: any) {
    console.error('Adult Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'ADULT' });
  }
});

app.get('/api/adult/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    
    const response = await axios.get(`${adultBase}/api/episodes/${id}`, {
      params: { code: adultToken, lang }
    });
    
    const epRows = response.data?.rows || [];
    const match = epRows.find((e: any) => String(e.episodeid) === String(ep) || String(e.episodeNumber) === String(ep));
    
    if (match) {
      const streamObj = match.videoUrls?.find((v: any) => v.quality === 'sd') || match.videoUrls?.[0];
      const streamUrl = streamObj?.url || '';
      
      if (streamUrl) {
        const reqHost = req.headers.host || '127.0.0.1:5001';
        const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=ADULT`;
        res.json({ data: { url: proxiedUrl }, platform: 'ADULT' });
      } else {
        res.json({ data: { url: '' }, error: 'No video URL found' });
      }
    } else {
      res.json({ data: { url: '' }, error: 'Episode not found' });
    }
  } catch (error: any) {
    console.error('Adult Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'ADULT' });
  }
});

app.get('/api/adult/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    
    const response = await axios.get(`${adultBase}/api/episodes/${id}`, {
      params: { code: adultToken, lang }
    });
    
    const epRows = response.data?.rows || [];
    const match = epRows.find((e: any) => String(e.episodeid) === String(ep) || String(e.episodeNumber) === String(ep));
    
    if (match && Array.isArray(match.subtitles)) {
      const targetSub = match.subtitles.find((s: any) => s.lang === 'id' || s.lang === 'in') || match.subtitles[0];
      if (targetSub && targetSub.url) {
        const list = await standardizeSubtitles(targetSub.url);
        return res.json({ data: { list }, platform: 'ADULT' });
      }
    }
    res.json({ data: { list: [] }, platform: 'ADULT' });
  } catch (error: any) {
    console.error('Adult Subtitle error:', error.message);
    res.json({ data: { list: [] }, platform: 'ADULT' });
  }
});

// --- ShortsWave Routes ---
const shortswaveBase = process.env.SHORTSWAVE_BASE_URL || 'https://shortwave.dramabos.my.id/api';
const shortswaveToken = process.env.SHORTSWAVE_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/shortswave/home', async (req, res) => {
  let { page = 1, lang = 'in' } = req.query;
  if (lang === 'id') lang = 'in';
  const cacheKey = `shortswave_home_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${shortswaveBase}/home`, {
      params: { page, lang, code: shortswaveToken }
    });
    const data = response.data?.data || response.data || {};
    const dramas = Array.isArray(data) ? data : (data.list || data.items || data.dramas || data.rows || []);
    const mapped = dramas.map((d: any) => ({
      id: String(d.id || d.videoid || d.drama_id || d.book_id || d.series_id || ''),
      title: d.title || d.name || d.drama_name || d.book_name || d.series_name || '',
      poster: d.poster || d.cover,
      episodes: d.episodes || d.total_episodes || 0,
      likes: d.likes || d.hot || '0',
      platform: 'SHORTSWAVE'
    }));
    const result = { dramas: mapped, platform: 'SHORTSWAVE' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('ShortsWave Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortswave/search', async (req, res) => {
  let { q = '', lang = 'in' } = req.query;
  if (lang === 'id') lang = 'in';
  const cacheKey = `shortswave_search_${q}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${shortswaveBase}/search`, {
      params: { q, lang, code: shortswaveToken }
    });
    const data = response.data?.data || response.data || {};
    const dramas = Array.isArray(data) ? data : (data.list || data.items || data.dramas || data.rows || []);
    const mapped = dramas.map((d: any) => ({
      id: d.id || d.videoid,
      title: d.title || d.name,
      poster: d.poster || d.cover,
      episodes: d.episodes || d.total_episodes || 0,
      likes: d.likes || d.hot || '0',
      platform: 'SHORTSWAVE'
    }));
    const result = { dramas: mapped, platform: 'SHORTSWAVE' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('ShortsWave Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/shortswave/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { lang = 'in' } = req.query;
    if (lang === 'id') lang = 'in';
    const response = await axios.get(`${shortswaveBase}/drama/${id}/episodes`, {
      params: { lang, code: shortswaveToken }
    });
    const data = response.data?.data || response.data || {};
    const series = data.drama || data.info || {};
    const rawEpisodes = Array.isArray(data) ? data : (data.episodes || data.list || data.chapter_list || data.items || []);
    const list = rawEpisodes.map((ep: any) => ({
      id: String(ep.id || ep.chapter_id || ep.chapterId || ep.videoid || ep.id_chapter || ep.index || ep.chapter_index || ''),
      title: ep.title || ep.name || `Episode ${ep.index || ep.chapter_index || ep.chapter_num || ''}`,
      episNum: ep.index || ep.chapter_index || ep.chapter_num || 1,
      cover: ep.cover || ep.poster || series.poster || series.cover || '',
      isVip: ep.is_vip === 1 || ep.need_unlock === 1 || ep.isVip || ep.vip === 1
    }));
    res.json({ data: { list, series }, platform: 'SHORTSWAVE' });
  } catch (error: any) {
    console.error('ShortsWave Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'SHORTSWAVE' });
  }
});

app.get('/api/shortswave/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    let { lang = 'in' } = req.query;
    if (lang === 'id') lang = 'in';

    let streamUrl = `${shortswaveBase}/stream/${id}/${ep}/v.m3u8?lang=${lang}&code=${shortswaveToken}`;
    
    // Auto-unlock before streaming and get the authenticated play_url
    try {
      const unlockRes = await axios.get(`${shortswaveBase}/unlock`, {
        params: { drama_id: id, chapter_id: ep, lang, code: shortswaveToken }
      });
      console.log(`[ShortsWave] Unlocked drama ${id} episode ${ep}`);
      
      const unlockData = unlockRes.data?.data || {};
      if (unlockData.play_url) {
        streamUrl = unlockData.play_url;
        console.log(`[ShortsWave] Using authenticated play_url`);
      }
    } catch (ue: any) {
      console.warn(`[ShortsWave] Unlock failed:`, ue.message);
    }
    const reqHost = req.headers.host || '127.0.0.1:5001';
    const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=SHORTSWAVE`;
    res.json({ data: { url: proxiedUrl }, platform: 'SHORTSWAVE' });
  } catch (error: any) {
    console.error('ShortsWave Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'SHORTSWAVE' });
  }
});

app.get('/api/shortswave/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    let { lang = 'in' } = req.query;
    if (lang === 'id') lang = 'in';
    const response = await axios.get(`${shortswaveBase}/drama/${id}/episodes`, {
      params: { lang, code: shortswaveToken },
      timeout: 15000
    });
    const data = response.data?.data || response.data || {};
    
    // Check if it's a list or a single object (unlock returns single object)
    let episode = null;
    if (Array.isArray(data)) {
      episode = data.find((e: any) => String(e.id) === String(ep) || String(e.chapter_id) === String(ep) || String(e.videoid) === String(ep));
    } else {
      // If it's a single object (from unlock), verify if it's the right one or just use it
      episode = data;
    }
    
    if (episode) {
      const subList = episode.sublist || episode.subtitle_list || episode.subtitles || episode.sub_list || episode.subtitleList || episode.termlist || [];
      if (Array.isArray(subList) && subList.length > 0) {
        const targetSub = subList.find((s: any) => {
          const sLang = (s.lang || s.language || s.code || s.languageId || '').toString().toLowerCase();
          return sLang === lang || sLang === 'id' || sLang === 'in' || sLang.includes('ind') || sLang.includes('indo');
        }) || subList[0];

        if (targetSub) {
          let url = targetSub.url || targetSub.subtitle || '';
          if (url) {
            if (url.startsWith('/')) {
              url = `${shortswaveBase}${url}`;
            }
            const list = await standardizeSubtitles(url);
            return res.json({ data: { list }, platform: 'SHORTSWAVE' });
          }
        }
      }
    }
    res.json({ data: { list: [] }, platform: 'SHORTSWAVE' });
  } catch (error) {
    res.json({ data: { list: [] }, platform: 'SHORTSWAVE' });
  }
});

// --- Anime Routes (Aggregated) ---
app.get('/api/anime/home', async (req, res) => {
  try {
    const { lang = 'id', page = 1 } = req.query;
    const p = Number(page);
    
    // Fetch ONLY from pure anime/donghua sources
    const [cubeRes, waveRes] = await Promise.allSettled([
      axios.get(`https://cubetv.dramabos.my.id/api/anime`, {
        params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang, moduleid: 'D0RxZA', page: p }
      }),
      axios.get(`https://dramawave.dramabos.my.id/api/anime`, {
        params: { lang: 'in', next: p }
      })
    ]);

    const cubeList = cubeRes.status === 'fulfilled' ? (cubeRes.value.data?.rows || []).map((d: any) => ({ ...d, platform: 'ANIME_CUBE' })) : [];
    const waveList = waveRes.status === 'fulfilled' ? (waveRes.value.data?.items || waveRes.value.data?.rows || waveRes.value.data?.data?.items || []).map((d: any) => ({ ...d, platform: 'ANIME_WAVE' })) : [];
    
    const list = [...cubeList, ...waveList];
    console.log(`[Anime Home] Cube:${cubeList.length}, Wave:${waveList.length}`);
    
    res.json({ dramas: list });
  } catch (error: any) {
    console.error('Anime Home error:', error.message);
    res.json({ dramas: [] });
  }
});

app.get('/api/anime/search', async (req, res) => {
  try {
    const { q = '', lang = 'id', page = 1 } = req.query;
    
    // Search in CubeTV
    const cubeRes = await axios.get(`https://cubetv.dramabos.my.id/api/search`, {
      params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang, q, page }
    });
    const cubeList = (cubeRes.data?.rows || []).map((d: any) => ({ ...d, platform: 'ANIME_CUBE' }));
    
    // Search in DramaWave (Using the new direct API)
    const waveRes = await axios.get(`https://dramawave.dramabos.my.id/api/search`, {
      params: { q, lang: 'in', code: 'A8D6AB170F7B89F2182561D3B32F390D', next: page }
    });
    const waveList = (waveRes.data?.data?.list || waveRes.data?.list || []).map((d: any) => ({ ...d, platform: 'ANIME_WAVE' }));
    
    const list = [...cubeList, ...waveList];
    
    res.json({ dramas: list });
  } catch (error: any) {
    console.error('Anime Search error:', error.message);
    res.json({ dramas: [] });
  }
});

// --- Anime Wave Specific Routes ---
app.get('/api/anime_wave/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await axios.get(`https://dramawave.dramabos.my.id/api/drama/${id}`, {
      params: { lang: 'in', code: 'A8D6AB170F7B89F2182561D3B32F390D' }
    });
    const mainData = response.data?.data || response.data || {};
    const chapters = mainData.items || [];
    
    const list = chapters.map((ep: any) => ({
      id: ep.id,
      title: `Episode ${ep.serial_number}`,
      episNum: ep.serial_number,
      cover: ep.cover || mainData.cover || '',
      isVip: ep.video_type !== 'free',
      streamUrl: ep.m3u8_path ? `http://${req.headers.host}/api/proxy/video?url=${encodeURIComponent(ep.m3u8_path)}&platform=ANIME_WAVE` : ''
    }));
    
    res.json({ data: { list, series: mainData }, platform: 'ANIME_WAVE' });
  } catch (error: any) {
    res.json({ data: { list: [], series: {} }, platform: 'ANIME_WAVE' });
  }
});

app.get('/api/anime_wave/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const response = await axios.get(`https://dramawave.dramabos.my.id/api/drama/${id}`, {
      params: { lang: 'in', code: 'A8D6AB170F7B89F2182561D3B32F390D' }
    });
    const mainData = response.data?.data || response.data || {};
    const match = (mainData.items || []).find((e: any) => String(e.id) === String(ep) || String(e.serial_number) === String(ep));
    
    if (match && match.m3u8_path) {
      const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const host = req.get('host') || req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = `${protocol}://${host}/api/proxy/video?url=${encodeURIComponent(match.m3u8_path)}&platform=ANIME_WAVE`;
      res.json({ data: { url: proxiedUrl }, platform: 'ANIME_WAVE' });
    } else {
      res.json({ data: { url: '' }, error: 'Stream not found' });
    }
  } catch (error) {
    res.json({ data: { url: '' }, platform: 'ANIME_WAVE' });
  }
});

app.get('/api/anime_wave/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const response = await axios.get(`https://dramawave.dramabos.my.id/api/drama/${id}`, {
      params: { lang: 'in', code: 'A8D6AB170F7B89F2182561D3B32F390D' }
    });
    const mainData = response.data?.data || response.data || {};
    const match = (mainData.items || []).find((e: any) => String(e.id) === String(ep) || String(e.serial_number) === String(ep));
    
    if (match && Array.isArray(match.subtitle_list)) {
      const targetSub = match.subtitle_list.find((s: any) => s.language === 'in' || s.language === 'id') || match.subtitle_list[0];
      if (targetSub) {
        const url = targetSub.subtitle || targetSub.url || '';
        const list = await standardizeSubtitles(url);
        return res.json({ data: { list }, platform: 'ANIME_WAVE' });
      }
    }
    res.json({ data: { list: [] }, platform: 'ANIME_WAVE' });
  } catch (error) {
    res.json({ data: { list: [] }, platform: 'ANIME_WAVE' });
  }
});

// --- Anime Cube Specific Routes ---
app.get('/api/anime_cube/episodes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { lang = 'id' } = req.query;
    const detailRes = await axios.get(`https://cubetv.dramabos.my.id/api/detail/${id}`, {
      params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang }
    });
    const seriesData = detailRes.data || {};
    const response = await axios.get(`https://cubetv.dramabos.my.id/api/episodes/${id}`, {
      params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang }
    });
    const epRows = response.data?.rows || [];
    const list = epRows.map((ep: any) => {
      const streamObj = ep.videoUrls?.find((v: any) => v.quality === 'sd') || ep.videoUrls?.[0];
      const streamUrl = streamObj?.url || '';
      const reqHost = req.headers.host || '127.0.0.1:5001';
      const proxiedUrl = streamUrl ? `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=ANIME_CUBE` : '';
      return {
        id: ep.episodeid,
        title: ep.episodeTitle || `Episode ${ep.episodeNumber}`,
        episNum: ep.episodeNumber,
        cover: seriesData.cover || '',
        isVip: ep.lockStatus === 1,
        streamUrl: proxiedUrl
      };
    });
    res.json({ data: { list, series: seriesData }, platform: 'ANIME_CUBE' });
  } catch (error: any) {
    res.json({ data: { list: [], series: {} }, platform: 'ANIME_CUBE' });
  }
});

app.get('/api/anime_cube/stream/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`https://cubetv.dramabos.my.id/api/episodes/${id}`, {
      params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang }
    });
    const epRows = response.data?.rows || [];
    const match = epRows.find((e: any) => String(e.episodeid) === String(ep) || String(e.episodeNumber) === String(ep));
    if (match) {
      const streamObj = match.videoUrls?.find((v: any) => v.quality === 'sd') || match.videoUrls?.[0];
      const streamUrl = streamObj?.url || '';
      if (streamUrl) {
        const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
        const host = req.get('host') || req.headers.host || '127.0.0.1:5001';
        const proxiedUrl = `${protocol}://${host}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=ANIME_CUBE`;
        res.json({ data: { url: proxiedUrl }, platform: 'ANIME_CUBE' });
      } else {
        res.json({ data: { url: '' }, error: 'No video URL found' });
      }
    } else {
      res.json({ data: { url: '' }, error: 'Episode not found' });
    }
  } catch (error) {
    res.json({ data: { url: '' }, platform: 'ANIME_CUBE' });
  }
});

app.get('/api/anime_cube/subtitle/:id/:ep', async (req, res) => {
  try {
    const { id, ep } = req.params;
    const { lang = 'id' } = req.query;
    const response = await axios.get(`https://cubetv.dramabos.my.id/api/episodes/${id}`, {
      params: { code: 'A8D6AB170F7B89F2182561D3B32F390D', lang }
    });
    const epRows = response.data?.rows || [];
    const match = epRows.find((e: any) => String(e.episodeid) === String(ep) || String(e.episodeNumber) === String(ep));
    if (match && Array.isArray(match.subtitles)) {
      const targetSub = match.subtitles.find((s: any) => s.lang === 'id' || s.lang === 'in') || match.subtitles[0];
      if (targetSub && targetSub.url) {
        const list = await standardizeSubtitles(targetSub.url);
        return res.json({ data: { list }, platform: 'ANIME_CUBE' });
      }
    }
    res.json({ data: { list: [] }, platform: 'ANIME_CUBE' });
  } catch (error) {
    res.json({ data: { list: [] }, platform: 'ANIME_CUBE' });
  }
});

app.post('/api/admin/clear-cache', (req, res) => {
  try {
    const { adminId } = req.body;
    if (adminId !== '5888747846') return res.status(403).send('Unauthorized');
    clearAllCache();
    res.json({ success: true, message: 'Cache and logs cleared successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Settings API
app.get('/api/settings', (req, res) => {
  try {
    const settings = db.prepare("SELECT * FROM app_settings").all() as any[];
    const result: any = {};
    settings.forEach(s => result[s.key] = s.value);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    const { key, value, adminId } = req.body;
    if (adminId !== '5888747846') return res.status(403).send('Unauthorized');
    
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, value);
    res.json({ success: true, key, value });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- StardustTV Routes ---
const stardusttvBase = process.env.STARDUSTTV_BASE_URL || 'https://stardusttv.dramabos.my.id/v1';
const stardusttvToken = process.env.STARDUSTTV_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/stardusttv/home', async (req, res) => {
  const { page = 1, lang = 'id' } = req.query;
  const cacheKey = `stardusttv_home_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${stardusttvBase}/list`, {
      params: { page, lang, code: stardusttvToken }
    });
    const list = response.data?.data || [];
    const mapped = list.map((d: any) => ({
      id: d.id,
      slug: d.slug,
      title: d.title,
      poster: d.poster,
      episodes: d.episodes || 0,
      likes: '0',
      platform: 'STARDUSTTV'
    }));
    const result = { dramas: mapped, platform: 'STARDUSTTV' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('StardustTV Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/stardusttv/search', async (req, res) => {
  const { q = '', lang = 'id' } = req.query;
  const cacheKey = `stardusttv_search_${q}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${stardusttvBase}/find`, {
      params: { q, lang, code: stardusttvToken }
    });
    const list = response.data?.data || [];
    const mapped = list.map((d: any) => ({
      id: d.id,
      slug: d.slug,
      title: d.title,
      poster: d.poster,
      episodes: d.episodes || 0,
      likes: '0',
      platform: 'STARDUSTTV'
    }));
    const result = { dramas: mapped, platform: 'STARDUSTTV' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('StardustTV Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/stardusttv/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'id' } = req.query;
  try {
    // API ignores slug, so we pass 'any'
    const response = await axios.get(`${stardusttvBase}/detail/any/${id}`, {
      params: { lang, code: stardusttvToken }
    });
    const data = response.data?.data;
    if (!data || !data.totalEpisodes) return res.json({ data: { list: [], series: {} }, platform: 'STARDUSTTV' });
    
    const epCount = Number(data.totalEpisodes);
    const list = [];
    for (let i = 1; i <= epCount; i++) {
      list.push({ id: i, number: i, title: `Episode ${i}` });
    }
    
    const series = {
      id: data.id,
      title: data.title,
      poster: data.poster,
      episodes: epCount
    };
    
    res.json({ data: { list, series }, platform: 'STARDUSTTV' });
  } catch (error: any) {
    console.error('StardustTV Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'STARDUSTTV' });
  }
});

app.get('/api/stardusttv/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  const { lang = 'id' } = req.query;
  try {
    const response = await axios.get(`${stardusttvBase}/detail/any/${id}/episode/${ep}`, {
      params: { lang, code: stardusttvToken }
    });
    const data = response.data?.data;
    if (!data) return res.json({ data: { url: '' }, platform: 'STARDUSTTV' });
    
    let streamUrl = data.h264 || data.h265 || '';
    if (streamUrl) {
      const reqHost = req.get('host');
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=STARDUSTTV`;
      res.json({ data: { url: proxiedUrl }, platform: 'STARDUSTTV' });
    } else {
      res.json({ data: { url: '' }, platform: 'STARDUSTTV' });
    }
  } catch (error: any) {
    console.error('StardustTV Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'STARDUSTTV' });
  }
});

app.get('/api/stardusttv/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'STARDUSTTV' });
});

// --- Reelife Routes ---
const reelifeBase = process.env.REELIFE_BASE_URL || 'https://reelife.dramabos.my.id/api/v1';
const reelifeToken = process.env.REELIFE_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/reelife/home', async (req, res) => {
  const { page = 1, lang = 'in' } = req.query;
  const cacheKey = `reelife_home_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${reelifeBase}/home`, { params: { page, lang } });
    const list = response.data?.dramas || response.data?.data?.list || [];
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap || d.coverPlays,
      episodes: d.lastChapterId || d.totalChapter || 0,
      likes: d.likeNum || '0',
      platform: 'REELIFE'
    }));
    const result = { dramas: mapped, platform: 'REELIFE' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('Reelife Home error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/reelife/search', async (req, res) => {
  const { q = '', lang = 'in', page = 1 } = req.query;
  const cacheKey = `reelife_search_${q}_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${reelifeBase}/search`, { params: { q, page, lang } });
    const list = response.data?.dramas || response.data?.data?.list || [];
    const mapped = list.map((d: any) => ({
      id: d.bookId,
      title: d.bookName,
      poster: d.coverWap || d.coverPlays,
      episodes: d.totalChapter || d.lastChapterId || 0,
      likes: d.likeNum || '0',
      platform: 'REELIFE'
    }));
    const result = { dramas: mapped, platform: 'REELIFE' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('Reelife Search error:', error.message);
    res.json({ dramas: [], platform: '', error: error.message });
  }
});

app.get('/api/reelife/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'in' } = req.query;
  try {
    const response = await axios.get(`${reelifeBase}/book/${id}/chapters`, { params: { lang } });
    const data = response.data?.data || response.data;
    const chapters = data?.chapterList || data || [];
    
    if (!Array.isArray(chapters) || chapters.length === 0) return res.json({ data: { list: [], series: {} }, platform: 'REELIFE' });
    
    const list = chapters.map((c: any) => ({
      id: c.chapterId,
      number: parseInt(c.chapterId),
      title: c.chapterName || `Episode ${c.chapterId}`
    }));
    
    const series = { id, title: '', poster: '', episodes: list.length };
    res.json({ data: { list, series }, platform: 'REELIFE' });
  } catch (error: any) {
    console.error('Reelife Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'REELIFE' });
  }
});

app.get('/api/reelife/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  const { lang = 'in' } = req.query;
  try {
    const response = await axios.get(`${reelifeBase}/play/${id}/${ep}`, {
      params: { code: reelifeToken, lang }
    });
    const data = response.data?.data || response.data;
    let streamUrl = data.videoUrl || (data.standbyUrls ? data.standbyUrls[0] : '');
    
    if (streamUrl) {
      const reqHost = req.get('host');
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=REELIFE`;
      res.json({ data: { url: proxiedUrl }, platform: 'REELIFE' });
    } else {
      res.json({ data: { url: '' }, platform: 'REELIFE' });
    }
  } catch (error: any) {
    console.error('Reelife Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'REELIFE' });
  }
});

app.get('/api/reelife/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'REELIFE' });
});

// --- StarShort Routes ---
const starshortBase = process.env.STARSHORT_BASE_URL || 'https://drakula.dramabos.my.id/api/starshort';
const starshortToken = process.env.STARSHORT_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

// StarShort aggregated pool cache (all sources combined, ~80+ items)
const starshortPoolCache: { [locale: string]: { items: any[], fetchedAt: number } } = {};
const STARSHORT_POOL_TTL = 30 * 60 * 1000; // 30 min

async function getStarShortPool(locale: string): Promise<any[]> {
  const now = Date.now();
  if (starshortPoolCache[locale] && now - starshortPoolCache[locale].fetchedAt < STARSHORT_POOL_TTL) {
    return starshortPoolCache[locale].items;
  }

  // Fetch multiple sources in parallel
  const [hotRes, trendRes, recRes, catRes] = await Promise.allSettled([
    axios.get(`${starshortBase}/content/hot`,        { params: { locale, code: starshortToken } }),
    axios.get(`${starshortBase}/content/trending`,   { params: { locale, code: starshortToken } }),
    axios.get(`${starshortBase}/content/recommended`,{ params: { locale, code: starshortToken } }),
    axios.get(`${starshortBase}/categories`,         { params: { locale, code: starshortToken } }),
  ]);

  let pool: any[] = [];

  // Add hot / trending / recommended
  for (const r of [hotRes, trendRes, recRes]) {
    if (r.status === 'fulfilled') {
      const items = r.value.data?.data || [];
      pool = pool.concat(items);
    }
  }

  // Fetch each category (up to 6 non-empty ones)
  if (catRes.status === 'fulfilled') {
    const cats: any[] = catRes.value.data?.data || [];
    const catFetches = cats.slice(0, 6).map((cat: any) =>
      axios.get(`${starshortBase}/categories/${cat.id}`, {
        params: { locale, p: 1, limit: 20, code: starshortToken }
      }).catch(() => null)
    );
    const catResults = await Promise.all(catFetches);
    for (const r of catResults) {
      if (r?.data?.data) pool = pool.concat(r.data.data);
    }
  }

  // Deduplicate by id
  const seen = new Set<string>();
  const deduped = pool.filter(item => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  starshortPoolCache[locale] = { items: deduped, fetchedAt: now };
  console.log(`[StarShort] Pool built for locale=${locale}: ${deduped.length} unique items`);
  return deduped;
}

app.get('/api/starshort/home', async (req, res) => {
  const { page = 1, lang = 'in', limit = 100 } = req.query;
  const locale = (lang === 'in' ? 'id' : lang) as string;
  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(50, Math.max(5, Number(limit)));

  const cacheKey = `starshort_home_${pageNum}_${limitNum}_${locale}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const pool = await getStarShortPool(locale);
    const start = (pageNum - 1) * limitNum;
    const slice = pool.slice(start, start + limitNum);
    const totalPages = Math.ceil(pool.length / limitNum);

    const mapped = slice.map((d: any) => ({
      id: d.id,
      title: d.title,
      poster: d.cover || '',
      episodes: d.total_episodes || 0,
      likes: '0',
      platform: 'STARSHORT'
    }));

    const result = { dramas: mapped, platform: 'STARSHORT', totalPages, totalItems: pool.length };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('StarShort Home error:', error.message);
    res.json({ dramas: [], platform: 'STARSHORT', error: error.message });
  }
});

app.get('/api/starshort/search', async (req, res) => {
  const { q = '', lang = 'in' } = req.query;
  const locale = lang === 'in' ? 'id' : lang;
  const cacheKey = `starshort_search_${q}_${locale}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${starshortBase}/search`, {
      params: { keyword: q, locale, code: starshortToken }
    });
    const list = response.data?.data || [];
    const mapped = list.map((d: any) => ({
      id: d.id,
      title: d.title,
      poster: d.cover || '',
      episodes: 0,
      likes: '0',
      platform: 'STARSHORT'
    }));
    const result = { dramas: mapped, platform: 'STARSHORT' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('StarShort Search error:', error.message);
    res.json({ dramas: [], platform: 'STARSHORT', error: error.message });
  }
});

app.get('/api/starshort/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'in' } = req.query;
  const locale = lang === 'in' ? 'id' : lang;
  try {
    const [detailRes, epRes] = await Promise.all([
      axios.get(`${starshortBase}/show/${id}`, { params: { locale, code: starshortToken } }),
      axios.get(`${starshortBase}/show/${id}/episodes`, { params: { locale, code: starshortToken } })
    ]);
    
    const showInfo = detailRes.data?.data || {};
    const chapters = epRes.data?.data?.episodes || [];
    
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.json({ data: { list: [], series: {} }, platform: 'STARSHORT' });
    }
    
    const list = chapters.map((c: any) => ({
      id: c.episode,
      number: Number(c.episode),
      title: `Episode ${c.episode}`
    }));
    
    const series = { 
      id, 
      title: showInfo.title || '', 
      poster: showInfo.cover || '', 
      episodes: showInfo.total_episodes || list.length 
    };
    res.json({ data: { list, series }, platform: 'STARSHORT' });
  } catch (error: any) {
    console.error('StarShort Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'STARSHORT', error: error.message });
  }
});

app.get('/api/starshort/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  const { lang = 'in' } = req.query;
  const locale = lang === 'in' ? 'id' : lang;
  try {
    const response = await axios.get(`${starshortBase}/watch/${id}/${ep}`, {
      params: { locale, code: starshortToken }
    });
    const data = response.data?.data;
    let streamUrl = data?.video_url || '';
    
    if (streamUrl) {
      const reqHost = req.get('host');
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=STARSHORT`;
      res.json({ data: { url: proxiedUrl }, platform: 'STARSHORT' });
    } else {
      res.json({ data: { url: '' }, platform: 'STARSHORT' });
    }
  } catch (error: any) {
    console.error('StarShort Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'STARSHORT', error: error.message });
  }
});

app.get('/api/starshort/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'STARSHORT' });
});

// --- MicroDrama Routes ---
const microdramaBase = process.env.MICRODRAMA_BASE_URL || 'https://drakula.dramabos.my.id/api/microdrama';
const microdramaToken = process.env.MICRODRAMA_TOKEN || 'A8D6AB170F7B89F2182561D3B32F390D';

app.get('/api/microdrama/home', async (req, res) => {
  const { page = 1, lang = 'id' } = req.query;
  const cacheKey = `microdrama_home_${page}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${microdramaBase}/list`, {
      params: { lang, page, limit: 20, code: microdramaToken }
    });
    const list = response.data?.data?.data || [];
    const mapped = list.map((d: any) => ({
      id: d.id,
      title: d.title,
      poster: d.cover,
      episodes: d.total_episodes || 0,
      likes: '0',
      platform: 'MICRODRAMA'
    }));
    const result = { dramas: mapped, platform: 'MICRODRAMA' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('MicroDrama Home error:', error.message);
    res.json({ dramas: [], platform: 'MICRODRAMA', error: error.message });
  }
});

app.get('/api/microdrama/search', async (req, res) => {
  const { q = '', lang = 'id' } = req.query;
  const cacheKey = `microdrama_search_${q}_${lang}`;
  const cached = getCache(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await axios.get(`${microdramaBase}/search`, {
      params: { q, lang, code: microdramaToken }
    });
    let list = response.data?.data?.dassi?.lspee || response.data?.data?.data || [];
    
    const mapped = list.map((d: any) => ({
      id: d.dope || d.id,
      title: d.ngrand || d.title,
      poster: d.pcoa || d.cover || '',
      episodes: d.eext || d.total_episodes || 0,
      likes: '0',
      platform: 'MICRODRAMA'
    }));
    const result = { dramas: mapped, platform: 'MICRODRAMA' };
    setCache(cacheKey, result);
    res.json(result);
  } catch (error: any) {
    console.error('MicroDrama Search error:', error.message);
    res.json({ dramas: [], platform: 'MICRODRAMA', error: error.message });
  }
});

app.get('/api/microdrama/episodes/:id', async (req, res) => {
  const { id } = req.params;
  const { lang = 'id' } = req.query;
  try {
    const response = await axios.get(`${microdramaBase}/drama/${id}`, {
      params: { lang, code: microdramaToken }
    });
    const showInfo = response.data?.data || {};
    const chapters = showInfo.episodes || [];
    
    if (!Array.isArray(chapters) || chapters.length === 0) {
      return res.json({ data: { list: [], series: {} }, platform: 'MICRODRAMA' });
    }
    
    const list = chapters.map((c: any) => ({
      id: c.episode,
      number: Number(c.episode),
      title: `Episode ${c.episode}`
    }));
    
    const series = { 
      id, 
      title: showInfo.title || '', 
      poster: showInfo.cover || '', 
      episodes: showInfo.total_episodes || list.length 
    };
    res.json({ data: { list, series }, platform: 'MICRODRAMA' });
  } catch (error: any) {
    console.error('MicroDrama Episodes error:', error.message);
    res.json({ data: { list: [], series: {} }, platform: 'MICRODRAMA', error: error.message });
  }
});

app.get('/api/microdrama/stream/:id/:ep', async (req, res) => {
  const { id, ep } = req.params;
  const { lang = 'id' } = req.query;
  try {
    const response = await axios.get(`${microdramaBase}/play/${id}/${ep}`, {
      params: { lang, code: microdramaToken }
    });
    const data = response.data?.data;
    const videos = data?.videos || [];
    let streamUrl = '';
    
    if (videos.length > 0) {
      const target = videos.find((v: any) => v.quality === '720P') || videos[0];
      streamUrl = target.url || '';
    }
    
    if (streamUrl) {
      const reqHost = req.get('host');
      const proxiedUrl = `http://${reqHost}/api/proxy/video?url=${encodeURIComponent(streamUrl)}&platform=MICRODRAMA`;
      res.json({ data: { url: proxiedUrl }, platform: 'MICRODRAMA' });
    } else {
      res.json({ data: { url: '' }, platform: 'MICRODRAMA', error: 'No video URL found' });
    }
  } catch (error: any) {
    console.error('MicroDrama Stream error:', error.message);
    res.json({ data: { url: '' }, platform: 'MICRODRAMA', error: error.message });
  }
});

app.get('/api/microdrama/subtitle/:id/:ep', async (req, res) => {
  res.json({ data: { list: [] }, platform: 'MICRODRAMA' });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
