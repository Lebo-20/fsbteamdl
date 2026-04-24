import os
import sys
import logging
import sqlite3
import asyncio
import random
import string
from datetime import datetime, timedelta
from contextlib import contextmanager
from typing import Dict, List, Tuple, Optional, Any
import time

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, MessageHandler, CallbackQueryHandler,
    filters, ContextTypes
)
from telegram.constants import ParseMode

# ===================== FIREBASE SYNC =====================
import firebase_sync
firebase_sync.init_firebase("firebase-key.json")

# ===================== KONFIGURASI =====================
BOT_TOKEN = "8598868295:AAHtIPKr7S0zqmjW7UhonZEwZREOvSQ1h0w"
ADMIN_IDS = [5888747846, 6337959812]
BACKUP_CHANNEL_ID = -1002549194754  # ID Channel untuk backup
LOG_CHANNEL_ID = -1003573270991     # Bisa sama atau beda
PRICE_PER_DAY = 1000
BOT_USERNAME = "ShortTeamDl_bot"

# Harga paket VIP Limited
VIP_LIMITED_1K_PRICE = 1000   # 1 hari, 2x lihat
VIP_LIMITED_3K_PRICE = 3000   # 3 hari, 6x lihat

# Konfigurasi QRIS
QRIS_IMAGE_URL = "https://image2url.com/r2/default/images/1771404079446-a6717d49-d801-4fd4-b508-e0ccbf7781b1.jpg"
PAYMENT_METHOD = "QRIS"

# Setup logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# ===================== DATABASE =====================
DATABASE_FILE = 'bot_database.db'

@contextmanager
def get_db():
    conn = sqlite3.connect(DATABASE_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_database():
    """Inisialisasi database dengan semua tabel yang diperlukan"""
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Tabel video dengan semua kolom yang diperlukan
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS videos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                file_id TEXT NOT NULL,
                caption TEXT DEFAULT 'Tanpa Judul',
                file_type TEXT NOT NULL,
                uploaded_by INTEGER NOT NULL,
                uploader_name TEXT NOT NULL,
                uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                backup_message_id INTEGER,
                log_message_id INTEGER,
                access_type TEXT DEFAULT 'FREE',
                view_count INTEGER DEFAULT 0
            )
        ''')
        
        # Cek dan tambah kolom jika belum ada
        cursor.execute("PRAGMA table_info(videos)")
        columns = cursor.fetchall()
        column_names = [column['name'] for column in columns]
        
        if 'uploader_name' not in column_names:
            try:
                cursor.execute("ALTER TABLE videos ADD COLUMN uploader_name TEXT NOT NULL DEFAULT 'Admin'")
                logger.info("Kolom uploader_name berhasil ditambahkan")
            except:
                pass
        
        if 'log_message_id' not in column_names:
            try:
                cursor.execute("ALTER TABLE videos ADD COLUMN log_message_id INTEGER")
                logger.info("Kolom log_message_id berhasil ditambahkan")
            except:
                pass
        
        if 'view_count' not in column_names:
            try:
                cursor.execute("ALTER TABLE videos ADD COLUMN view_count INTEGER DEFAULT 0")
                logger.info("Kolom view_count berhasil ditambahkan")
            except:
                pass
        
        # Tabel user
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                username TEXT,
                first_name TEXT,
                vip_until TIMESTAMP,
                vip_limited_until TIMESTAMP,
                vip_limited_views INTEGER DEFAULT 0,
                vip_limited_total_views INTEGER DEFAULT 2,
                is_admin INTEGER DEFAULT 0,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        
        # Cek dan tambah kolom VIP Limited jika belum ada
        cursor.execute("PRAGMA table_info(users)")
        columns = cursor.fetchall()
        column_names = [column['name'] for column in columns]
        
        if 'vip_limited_until' not in column_names:
            try:
                cursor.execute("ALTER TABLE users ADD COLUMN vip_limited_until TIMESTAMP")
                logger.info("Kolom vip_limited_until berhasil ditambahkan")
            except:
                pass
        
        if 'vip_limited_views' not in column_names:
            try:
                cursor.execute("ALTER TABLE users ADD COLUMN vip_limited_views INTEGER DEFAULT 0")
                logger.info("Kolom vip_limited_views berhasil ditambahkan")
            except:
                pass
        
        if 'vip_limited_total_views' not in column_names:
            try:
                cursor.execute("ALTER TABLE users ADD COLUMN vip_limited_total_views INTEGER DEFAULT 2")
                logger.info("Kolom vip_limited_total_views berhasil ditambahkan")
            except:
                pass
        
        # Tabel payment
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                amount INTEGER NOT NULL,
                days INTEGER NOT NULL,
                payment_type TEXT DEFAULT 'REGULAR',
                proof_file_id TEXT,
                status TEXT DEFAULT 'PENDING',
                approved_by INTEGER,
                approved_at TIMESTAMP,
                rejected_reason TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        ''')
        
        # Cek dan tambah kolom payment_type jika belum ada
        cursor.execute("PRAGMA table_info(payments)")
        columns = cursor.fetchall()
        column_names = [column['name'] for column in columns]
        
        if 'payment_type' not in column_names:
            try:
                cursor.execute("ALTER TABLE payments ADD COLUMN payment_type TEXT DEFAULT 'REGULAR'")
                logger.info("Kolom payment_type berhasil ditambahkan")
            except:
                pass
        
        # Tabel broadcast
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS broadcasts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admin_id INTEGER NOT NULL,
                message_type TEXT NOT NULL,
                content TEXT,
                file_id TEXT,
                caption TEXT,
                total_recipients INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,
                fail_count INTEGER DEFAULT 0,
                status TEXT DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP,
                FOREIGN KEY (admin_id) REFERENCES users(user_id)
            )
        ''')
        
        # Tabel broadcast_queue untuk pengiriman background
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS broadcast_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                broadcast_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                status TEXT DEFAULT 'PENDING',
                error_message TEXT,
                sent_at TIMESTAMP,
                FOREIGN KEY (broadcast_id) REFERENCES broadcasts(id),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        ''')
        
        # Tabel stats
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                video_id INTEGER,
                user_id INTEGER,
                action TEXT,
                metadata TEXT,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (video_id) REFERENCES videos(id),
                FOREIGN KEY (user_id) REFERENCES users(user_id)
            )
        ''')
        
        # Cek dan tambah kolom metadata jika belum ada di tabel stats
        cursor.execute("PRAGMA table_info(stats)")
        columns = cursor.fetchall()
        column_names = [column['name'] for column in columns]
        
        if 'metadata' not in column_names:
            try:
                cursor.execute("ALTER TABLE stats ADD COLUMN metadata TEXT")
                logger.info("Kolom metadata berhasil ditambahkan ke tabel stats")
            except Exception as e:
                logger.error(f"Gagal menambahkan kolom metadata ke stats: {e}")
        
        # Tabel redeem codes untuk kode VIP (diperbarui untuk multi-user)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS redeem_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code TEXT UNIQUE NOT NULL,
                days INTEGER DEFAULT 1,
                max_views INTEGER DEFAULT 4,
                max_redeems INTEGER DEFAULT 1,
                created_by INTEGER NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (created_by) REFERENCES users(user_id)
            )
        ''')

        # Tabel source_groups untuk pengumpul video otomatis
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS source_groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL,
                thread_id INTEGER,
                title TEXT,
                link TEXT,
                status TEXT DEFAULT 'ACTIVE',
                is_active INTEGER DEFAULT 1,
                last_read TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(chat_id, thread_id)
            )
        ''')
        
        # Cek dan tambah kolom jika belum ada di source_groups
        cursor.execute("PRAGMA table_info(source_groups)")
        columns = [column['name'] for column in cursor.fetchall()]
        
        if 'thread_id' not in columns:
            try:
                cursor.execute("ALTER TABLE source_groups ADD COLUMN thread_id INTEGER")
                logger.info("Kolom thread_id berhasil ditambahkan ke source_groups")
            except: pass
            
        if 'link' not in columns:
            try:
                cursor.execute("ALTER TABLE source_groups ADD COLUMN link TEXT")
                logger.info("Kolom link berhasil ditambahkan ke source_groups")
            except: pass
            
        if 'is_active' not in columns:
            try:
                cursor.execute("ALTER TABLE source_groups ADD COLUMN is_active INTEGER DEFAULT 1")
                logger.info("Kolom is_active berhasil ditambahkan ke source_groups")
            except: pass
            
        if 'last_read' not in columns:
            try:
                cursor.execute("ALTER TABLE source_groups ADD COLUMN last_read TIMESTAMP")
                logger.info("Kolom last_read berhasil ditambahkan ke source_groups")
            except: pass

        # MIGRASI: Hapus UNIQUE chat_id jika masih ada
        try:
            cursor.execute("PRAGMA index_list(source_groups)")
            indexes = cursor.fetchall()
            has_old_unique = False
            for idx in indexes:
                if idx['unique'] == 1 and idx['name'].startswith('sqlite_autoindex_source_groups'):
                    has_old_unique = True
                    break
            
            if has_old_unique:
                logger.info("Memperbarui skema source_groups untuk mendukung multi-topik...")
                # Backup data
                cursor.execute("SELECT * FROM source_groups")
                old_data = cursor.fetchall()
                
                # Recreate table
                cursor.execute("DROP TABLE source_groups")
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS source_groups (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        chat_id INTEGER NOT NULL,
                        thread_id INTEGER,
                        title TEXT,
                        link TEXT,
                        status TEXT DEFAULT 'ACTIVE',
                        is_active INTEGER DEFAULT 1,
                        last_read TIMESTAMP,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(chat_id, thread_id)
                    )
                ''')
                
                # Restore data (be careful with duplicates)
                for row in old_data:
                    try:
                        cursor.execute("""
                            INSERT INTO source_groups (id, chat_id, thread_id, title, link, status, is_active, last_read, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, tuple(row))
                    except: pass
                logger.info("Skema source_groups berhasil diperbarui!")
        except Exception as e:
            logger.error(f"Gagal migrasi skema source_groups: {e}")

        # Tabel settings untuk pengaturan global bot
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        ''')
        
        # Default setting: protect_content = OFF
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('protect_content', 'OFF')")
        
        conn.commit()

        # Tabel riwayat redeem untuk mencatat user yang sudah klaim
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS redeem_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                code_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                redeemed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (code_id) REFERENCES redeem_codes(id),
                FOREIGN KEY (user_id) REFERENCES users(user_id),
                UNIQUE(code_id, user_id)
            )
        ''')

        conn.commit()
        logger.info("Database initialized successfully")

# ===================== UTILITY FUNCTIONS =====================
async def delete_previous_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Menghapus pesan terakhir dari bot untuk menghindari penumpukan (anti-spam)"""
    last_msg_id = context.user_data.get('last_msg_id')
    if last_msg_id:
        try:
            await context.bot.delete_message(chat_id=update.effective_chat.id, message_id=last_msg_id)
        except Exception:
            pass
    # Hapus juga pesan user jika memungkinkan
    try:
        await update.message.delete()
    except Exception:
        pass

def generate_video_code(length: int = 8) -> str:
    """
    Generate kode video unik
    Format: 6-10 karakter random huruf+angka
    """
    characters = string.ascii_uppercase + string.digits
    code_length = random.randint(6, 10)
    random_part = ''.join(random.choices(characters, k=code_length))
    code = f"MKV{random_part}"
    return code

def generate_redeem_code() -> str:
    """Generate kode redeem VIP unik. Format: VIP-XXXXX"""
    characters = string.ascii_uppercase + string.digits
    random_part = ''.join(random.choices(characters, k=5))
    return f"VIP-{random_part}"

def generate_broadcast_id() -> str:
    """Generate ID unik untuk broadcast"""
    timestamp = int(time.time())
    random_part = ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"BC{timestamp}{random_part}"

def get_user_display_name(user) -> str:
    """Mendapatkan nama depan user atau username"""
    if user.first_name:
        return user.first_name
    elif user.username:
        return f"@{user.username}"
    else:
        return f"User_{user.id}"

def get_user_status(user_id: int) -> dict:
    """Mendapatkan status lengkap user"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        user = cursor.fetchone()
        
        if not user:
            return None
        
        user_dict = dict(user)
        now = datetime.now()
        
        # Hitung status VIP Regular
        if user_dict.get('vip_until'):
            try:
                vip_until = datetime.fromisoformat(user_dict['vip_until'])
                
                if vip_until > now:
                    user_dict['vip_status'] = 'REGULAR_AKTIF'
                    user_dict['vip_icon'] = '💎'
                    user_dict['vip_type'] = 'REGULAR'
                    remaining = vip_until - now
                    user_dict['days_left'] = remaining.days
                    user_dict['hours_left'] = remaining.seconds // 3600
                    user_dict['expiry_date'] = vip_until.strftime('%d %B %Y %H:%M')
                else:
                    user_dict['vip_status'] = 'REGULAR_EXPIRED'
                    user_dict['vip_icon'] = '❌'
                    user_dict['vip_type'] = 'NONE'
                    user_dict['days_left'] = 0
                    user_dict['hours_left'] = 0
                    user_dict['expiry_date'] = vip_until.strftime('%d %B %Y %H:%M')
            except:
                user_dict['vip_status'] = 'TIDAK AKTIF'
                user_dict['vip_icon'] = '❌'
                user_dict['vip_type'] = 'NONE'
                user_dict['days_left'] = 0
                user_dict['hours_left'] = 0
                user_dict['expiry_date'] = '-'
        else:
            user_dict['vip_status'] = 'TIDAK AKTIF'
            user_dict['vip_icon'] = '❌'
            user_dict['vip_type'] = 'NONE'
            user_dict['days_left'] = 0
            user_dict['hours_left'] = 0
            user_dict['expiry_date'] = '-'
        
        # Hitung status VIP Limited
        if user_dict.get('vip_limited_until'):
            try:
                limited_until = datetime.fromisoformat(user_dict['vip_limited_until'])
                total_views = user_dict.get('vip_limited_total_views', 2)
                
                if limited_until > now and user_dict.get('vip_limited_views', 0) < total_views:
                    user_dict['vip_limited_status'] = 'LIMITED_AKTIF'
                    user_dict['vip_limited_icon'] = '🔰'
                    user_dict['vip_type'] = 'LIMITED'
                    remaining = limited_until - now
                    user_dict['limited_days_left'] = remaining.days
                    user_dict['limited_hours_left'] = remaining.seconds // 3600
                    user_dict['limited_views_left'] = total_views - user_dict['vip_limited_views']
                    user_dict['limited_expiry_date'] = limited_until.strftime('%d %B %Y %H:%M')
                    user_dict['vip_limited_total_views'] = total_views
                else:
                    user_dict['vip_limited_status'] = 'LIMITED_EXPIRED'
                    user_dict['vip_limited_icon'] = '❌'
                    user_dict['limited_views_left'] = 0
                    user_dict['limited_expiry_date'] = limited_until.strftime('%d %B %Y %H:%M') if limited_until else '-'
                    user_dict['vip_limited_total_views'] = total_views
            except:
                user_dict['vip_limited_status'] = 'LIMITED_TIDAK_AKTIF'
                user_dict['vip_limited_icon'] = '❌'
                user_dict['limited_views_left'] = 0
                user_dict['limited_expiry_date'] = '-'
                user_dict['vip_limited_total_views'] = 2
        else:
            user_dict['vip_limited_status'] = 'LIMITED_TIDAK_AKTIF'
            user_dict['vip_limited_icon'] = '❌'
            user_dict['limited_views_left'] = 0
            user_dict['limited_expiry_date'] = '-'
            user_dict['vip_limited_total_views'] = 2
        
        # Tentukan status VIP keseluruhan
        if user_dict.get('vip_status') == 'REGULAR_AKTIF':
            user_dict['vip_overall'] = 'REGULAR'
            user_dict['vip_overall_icon'] = '💎'
        elif user_dict.get('vip_limited_status') == 'LIMITED_AKTIF':
            user_dict['vip_overall'] = 'LIMITED'
            user_dict['vip_overall_icon'] = '🔰'
        else:
            user_dict['vip_overall'] = 'NONE'
            user_dict['vip_overall_icon'] = '❌'
        
        # Cek pembayaran pending
        cursor.execute("""
            SELECT COUNT(*) as pending_count FROM payments 
            WHERE user_id = ? AND status = 'PENDING'
        """, (user_id,))
        result = cursor.fetchone()
        user_dict['pending_payments'] = result['pending_count'] if result else 0
        
        return user_dict

def is_vip(user_id: int) -> bool:
    """Cek apakah user VIP (Regular atau Limited)"""
    status = get_user_status(user_id)
    return status and (status['vip_overall'] in ['REGULAR', 'LIMITED'])

def is_vip_regular(user_id: int) -> bool:
    """Cek apakah user VIP Regular"""
    status = get_user_status(user_id)
    return status and status['vip_overall'] == 'REGULAR'

def is_vip_limited(user_id: int) -> bool:
    """Cek apakah user VIP Limited dengan sisa views > 0"""
    status = get_user_status(user_id)
    return status and status['vip_overall'] == 'LIMITED' and status.get('limited_views_left', 0) > 0

def can_access_vip(user_id: int) -> bool:
    """Cek apakah user bisa mengakses video VIP"""
    return is_vip_regular(user_id) or is_vip_limited(user_id)

def get_setting(key, default='OFF'):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
        result = cursor.fetchone()
        return result['value'] if result else default

def set_setting(key, value):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()

def is_admin(user_id: int) -> bool:
    """Cek apakah user admin"""
    if user_id in ADMIN_IDS:
        return True
    return False

def get_user_or_create(user_id: int, username: str = None, first_name: str = None):
    """Get atau create user"""
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
        user = cursor.fetchone()
        
        if not user:
            cursor.execute("""
                INSERT INTO users (user_id, username, first_name, vip_limited_views, vip_limited_total_views)
                VALUES (?, ?, ?, 0, 2)
            """, (user_id, username, first_name))
            conn.commit()
            
            # [FIREBASE] Sync user baru ke Firestore
            firebase_sync.sync_user_create(user_id, username, first_name)
            
            cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
            user = cursor.fetchone()
        
        return user

def get_video_by_caption(caption: str) -> Optional[dict]:
    """Mendapatkan data video berdasarkan judul (caption)"""
    if not caption or caption.strip() == "" or caption == "Tanpa Judul":
        return None
        
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM videos WHERE caption = ?", (caption,))
        row = cursor.fetchone()
        return dict(row) if row else None

def generate_video_link(video_code: str) -> str:
    """Generate link untuk video dengan format yang diminta"""
    return f"https://t.me/{BOT_USERNAME}?start={video_code}"

def format_backup_caption(
    video_code: str, 
    caption: str, 
    uploader_name: str, 
    waktu: str,
    access_type: str = "free / vip sesuai setingan setelah upload"
) -> str:
    """
    Format caption untuk backup video sesuai spesifikasi
    """
    video_link = generate_video_link(video_code)
    
    # Gunakan judul default jika caption kosong
    if not caption or caption.strip() == "":
        caption = "Tanpa Judul"
    
    backup_text = (
        f"📹 Backup Video\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"🔓 Tipe: {access_type}\n"
        f"📌 Kode: {video_code}\n"
        f"🔗 Link: {video_link}\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"📝 Judul: {caption}\n"
        f"👤 Upload oleh: {uploader_name}\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"⏰ Waktu: {waktu}\n"
        f"━━━━━━━━━━━━━━━━━━━"
    )
    
    return backup_text

def create_video_keyboard(video_id: int, access_type: str) -> InlineKeyboardMarkup:
    """
    Membuat keyboard inline untuk video
    """
    keyboard = [
        [
            InlineKeyboardButton("🎬 Buka Video", callback_data=f"video_open_{video_id}"),
            InlineKeyboardButton("🔒 Ubah Tipe", callback_data=f"video_changetype_{video_id}")
        ],
        [
            InlineKeyboardButton("🗑 Hapus", callback_data=f"video_delete_{video_id}")
        ]
    ]
    
    # Tambahkan indikator tipe saat ini
    if access_type == "FREE":
        keyboard.insert(0, [InlineKeyboardButton("✅ Saat ini: FREE", callback_data="no_action")])
    else:
        keyboard.insert(0, [InlineKeyboardButton("✅ Saat ini: VIP", callback_data="no_action")])
    
    return InlineKeyboardMarkup(keyboard)

# ===================== SAFE EDIT FUNCTION =====================
async def safe_edit_message(query, text, reply_markup=None, parse_mode=None):
    """
    Fungsi aman untuk mengedit pesan.
    Jika pesan tidak memiliki teks, kirim pesan baru.
    """
    try:
        if query.message.text is not None:
            await query.edit_message_text(
                text,
                reply_markup=reply_markup,
                parse_mode=parse_mode
            )
        else:
            # Pesan tidak memiliki teks (foto/video), kirim pesan baru
            await query.message.reply_text(
                text,
                reply_markup=reply_markup,
                parse_mode=parse_mode
            )
            # Hapus pesan lama
            try:
                await query.message.delete()
            except:
                pass
    except Exception as e:
        logger.error(f"Error in safe_edit_message: {e}")
        # Fallback: kirim pesan baru
        await query.message.reply_text(
            text,
            reply_markup=reply_markup,
            parse_mode=parse_mode
        )

# ===================== PAGINATION FUNCTION =====================
def paginate_results(results: list, page: int = 1, per_page: int = 5) -> dict:
    """
    Membagi hasil pencarian menjadi halaman-halaman
    """
    total_items = len(results)
    total_pages = (total_items + per_page - 1) // per_page
    
    if page < 1:
        page = 1
    if page > total_pages and total_pages > 0:
        page = total_pages
    
    start_idx = (page - 1) * per_page
    end_idx = min(start_idx + per_page, total_items)
    
    items = results[start_idx:end_idx]
    
    return {
        'items': items,
        'total_pages': total_pages,
        'current_page': page,
        'has_prev': page > 1,
        'has_next': page < total_pages,
        'start_idx': start_idx + 1,
        'total_items': total_items
    }

# ===================== SEARCH FUNCTIONS =====================
def search_videos(keyword: str, limit: int = 50) -> list:
    """
    Mencari video berdasarkan judul/caption
    """
    with get_db() as conn:
        cursor = conn.cursor()
        
        keyword = keyword.replace('!', '!!').replace('%', '!%').replace('_', '!_')
        
        cursor.execute('''
            SELECT * FROM videos 
            WHERE caption LIKE ? ESCAPE '!'
            ORDER BY 
                CASE 
                    WHEN caption LIKE ? THEN 1
                    ELSE 2
                END,
                view_count DESC,
                uploaded_at DESC
            LIMIT ?
        ''', (f'%{keyword}%', f'{keyword}%', limit))
        
        results = cursor.fetchall()
        
        return [dict(row) for row in results]

# ===================== /update - UPDATE BOT FROM GITHUB =====================
async def update_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /update - menarik pembaruan dari GitHub (admin only)"""
    user = update.effective_user
    
    if not is_admin(user.id):
        return
    
    msg = await update.message.reply_text("🔄 <b>Sedang menarik pembaruan dari GitHub...</b>", parse_mode=ParseMode.HTML)
    
    try:
        import subprocess
        process = subprocess.Popen(["git", "pull"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = process.communicate()
        
        if process.returncode == 0:
            if "Already up to date." in stdout:
                await msg.edit_text("✅ <b>Bot sudah dalam versi terbaru.</b>", parse_mode=ParseMode.HTML)
            else:
                await msg.edit_text(
                    f"✅ <b>Berhasil menarik pembaruan!</b>\n\n"
                    f"<code>{stdout}</code>\n\n"
                    f"🔄 <b>Merestart bot...</b>", 
                    parse_mode=ParseMode.HTML
                )
                # Restart bot
                os.execl(sys.executable, sys.executable, *sys.argv)
        else:
            await msg.edit_text(
                f"❌ <b>Gagal menarik pembaruan:</b>\n\n"
                f"<code>{stderr}</code>", 
                parse_mode=ParseMode.HTML
            )
    except Exception as e:
        await msg.edit_text(f"❌ <b>Terjadi kesalahan:</b> {e}", parse_mode=ParseMode.HTML)

# ===================== COMMAND HANDLERS =====================

# ===================== /db - CEK STATUS FIREBASE =====================
async def db_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /db - cek status database Firebase (admin only)"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Perintah ini hanya untuk admin!")
        return
    
    keyboard = [
        [InlineKeyboardButton("🔥 Lihat Status DB", callback_data="admin_db_status")],
        [InlineKeyboardButton("🎟️ Kode Redeem VIP", callback_data="admin_redeem_menu")],
        [InlineKeyboardButton("⚙️ Panel Admin", callback_data="admin_panel")]
    ]
    
    await update.message.reply_text(
        "🔥 <b>DATABASE ONLINE</b>\n\n"
        "Pilih menu di bawah untuk melihat status database Firebase atau kelola kode redeem VIP.",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode=ParseMode.HTML
    )

# ===================== /cekuser - CEK STATUS USER =====================
async def cekuser_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /cekuser - mengecek status user (admin only)"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Perintah ini hanya untuk admin!")
        return
        
    if not context.args or len(context.args) == 0:
        await update.message.reply_text("ℹ️ Penggunaan: /cekuser <user_id>")
        return
        
    try:
        target_user_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ User ID harus berupa angka!")
        return
        
    status = get_user_status(target_user_id)
    
    if not status:
        await update.message.reply_text(f"❌ Data user dengan ID {target_user_id} tidak ditemukan di database.")
        return
    
    pending_text = ""
    if status.get('pending_payments', 0) > 0:
        pending_text = f"\n⏳ Pembayaran Pending: {status['pending_payments']}"
    
    if status.get('vip_overall') == 'REGULAR':
        message = (
            f"👤 STATUS USER\n\n"
            f"🆔 User ID: {status['user_id']}\n"
            f"📛 Nama: {status.get('first_name', 'Tidak diketahui')}\n"
            f"📱 Username: @{status.get('username') or 'None'}\n\n"
            f"{status.get('vip_icon', '💎')} Status VIP: REGULAR AKTIF\n"
            f"💎 Tipe: VIP Regular (Full Akses)\n"
            f"📅 Berlaku sampai: {status.get('expiry_date', '-')}\n"
            f"⏳ Sisa waktu: {status.get('days_left', 0)} hari {status.get('hours_left', 0)} jam\n"
            f"{pending_text}"
        )
    elif status.get('vip_overall') == 'LIMITED':
        total_views = status.get('vip_limited_total_views', 2)
        views_left = status.get('limited_views_left', 0)
        message = (
            f"👤 STATUS USER\n\n"
            f"🆔 User ID: {status['user_id']}\n"
            f"📛 Nama: {status.get('first_name', 'Tidak diketahui')}\n"
            f"📱 Username: @{status.get('username') or 'None'}\n\n"
            f"{status.get('vip_limited_icon', '🔰')} Status VIP: LIMITED AKTIF\n"
            f"🔰 Tipe: VIP Limited ({total_views}x Lihat)\n"
            f"📅 Berlaku sampai: {status.get('limited_expiry_date', '-')}\n"
            f"⏳ Sisa waktu: {status.get('limited_days_left', 0)} hari {status.get('limited_hours_left', 0)} jam\n"
            f"👁 Sisa kuota lihat: {views_left} dari {total_views} kali\n"
            f"{pending_text}"
        )
    else:
        message = (
            f"👤 STATUS USER\n\n"
            f"🆔 User ID: {status['user_id']}\n"
            f"📛 Nama: {status.get('first_name', 'Tidak diketahui')}\n"
            f"📱 Username: @{status.get('username') or 'None'}\n\n"
            f"❌ Status VIP: TIDAK AKTIF\n"
            f"💎 Tipe: Free User\n"
            f"{pending_text}"
        )
        
    await update.message.reply_text(message)

# ===================== /addvip - TAMBAH VIP MANUAL =====================
async def addvip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /addvip - menambah VIP manual (admin only)"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Perintah ini hanya untuk admin!")
        return
        
    # Format: /addvip <user_id> <hari> [tipe: regular/limited]
    if not context.args or len(context.args) < 2:
        await update.message.reply_text(
            "ℹ️ <b>Penggunaan:</b>\n"
            "<code>/addvip <user_id> <hari> [tipe]</code>\n\n"
            "<b>Contoh:</b>\n"
            "<code>/addvip 123456789 30</code> (Tambah 30 hari VIP Regular)\n"
            "<code>/addvip 123456789 3 limited</code> (Tambah 3 hari VIP Limited)",
            parse_mode=ParseMode.HTML
        )
        return
        
    try:
        target_user_id = int(context.args[0])
        days = int(context.args[1])
    except ValueError:
        await update.message.reply_text("❌ User ID dan Hari harus berupa angka!")
        return
        
    vip_type = "regular"
    if len(context.args) > 2:
        vip_type = context.args[2].lower()
        if vip_type not in ["regular", "limited"]:
            await update.message.reply_text("❌ Tipe VIP hanya bisa 'regular' atau 'limited'!")
            return

    # Pastikan user ada di DB
    target_user = get_user_status(target_user_id)
    if not target_user:
        get_user_or_create(target_user_id)
        target_user = get_user_status(target_user_id)
        
    now = datetime.now()
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        if vip_type == "regular":
            if target_user.get('vip_until'):
                try:
                    current_vip = datetime.fromisoformat(target_user['vip_until'])
                    if current_vip < now:
                        new_vip = now + timedelta(days=days)
                    else:
                        new_vip = current_vip + timedelta(days=days)
                except:
                    new_vip = now + timedelta(days=days)
            else:
                new_vip = now + timedelta(days=days)
                
            cursor.execute("UPDATE users SET vip_until = ? WHERE user_id = ?", (new_vip.isoformat(), target_user_id))
            conn.commit()
            
            try:
                import firebase_sync
                firebase_sync.sync_user_vip_regular(target_user_id, new_vip.isoformat())
            except:
                pass
            
            tipe_text = "VIP Regular (Full Akses)"
            berlaku_text = new_vip.strftime('%d %B %Y %H:%M')
            
        else: # limited
            if target_user.get('vip_limited_until'):
                try:
                    current_vip = datetime.fromisoformat(target_user['vip_limited_until'])
                    if current_vip < now:
                        new_vip = now + timedelta(days=days)
                    else:
                        new_vip = current_vip + timedelta(days=days)
                except:
                    new_vip = now + timedelta(days=days)
            else:
                new_vip = now + timedelta(days=days)
                
            # Default views: 1 hari = 2 views, 3 hari = 6 views
            views_to_add = days * 2
            current_views = target_user.get('vip_limited_total_views', 2)
            
            cursor.execute("UPDATE users SET vip_limited_until = ?, vip_limited_views = 0, vip_limited_total_views = ? WHERE user_id = ?", 
                          (new_vip.isoformat(), views_to_add, target_user_id))
            conn.commit()
            
            try:
                import firebase_sync
                firebase_sync.sync_user_vip_limited(target_user_id, new_vip.isoformat(), 0, views_to_add)
            except:
                pass
                
            tipe_text = f"VIP Limited ({views_to_add}x Lihat)"
            berlaku_text = new_vip.strftime('%d %B %Y %H:%M')

    await update.message.reply_text(
        f"✅ <b>Berhasil Menambahkan VIP!</b>\n\n"
        f"👤 User ID: <code>{target_user_id}</code>\n"
        f"💎 Tipe: {tipe_text}\n"
        f"⏳ Durasi: {days} Hari\n"
        f"📅 Berlaku sampai: {berlaku_text}",
        parse_mode=ParseMode.HTML
    )
    
    try:
        await context.bot.send_message(
            chat_id=target_user_id,
            text=(
                f"🎉 <b>SELAMAT! ANDA MENDAPATKAN VIP</b>\n\n"
                f"Admin telah menambahkan VIP ke akun Anda.\n\n"
                f"💎 Tipe: {tipe_text}\n"
                f"⏳ Tambahan Waktu: {days} Hari\n"
                f"📅 Berlaku sampai: {berlaku_text}\n\n"
                f"Ketik /status untuk mengecek membership Anda."
            ),
            parse_mode=ParseMode.HTML
        )
    except:
        pass

# ===================== /tarikdata - PULL DARI FIREBASE KE VPS =====================
async def tarikdata_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk menarik data dari Firebase ke VPS SQLite (admin only)"""
    user = update.effective_user
    if not is_admin(user.id):
        await update.message.reply_text("❌ Perintah ini hanya untuk admin!")
        return
        
    msg = await update.message.reply_text("🔄 <b>Sedang menarik data dari Firebase...</b>\nProses ini mungkin memakan waktu beberapa detik.", parse_mode=ParseMode.HTML)
    
    try:
        import subprocess
        import sys
        # Gunakan executable python yang sedang menjalankan bot
        process = subprocess.Popen([sys.executable, "pull_from_firebase.py"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout, stderr = process.communicate()
        
        if process.returncode == 0:
            await msg.edit_text(
                f"✅ <b>SINKRONISASI SELESAI!</b>\n\n"
                f"Semua data dari Firebase Online telah berhasil di-download ke database lokal VPS.\n\n"
                f"⚠️ <b>PENTING:</b> Silakan ketik perintah /update untuk merestart bot agar data terbaru langsung dimuat.", 
                parse_mode=ParseMode.HTML
            )
        else:
            await msg.edit_text(
                f"❌ <b>Gagal menarik data:</b>\n\n"
                f"<code>{stderr[:500]}</code>", 
                parse_mode=ParseMode.HTML
            )
    except Exception as e:
        await msg.edit_text(f"❌ <b>Terjadi kesalahan:</b> {e}", parse_mode=ParseMode.HTML)

# ===================== /redeem - REDEEM KODE VIP =====================
async def redeem_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /redeem KODE - user menukarkan kode VIP"""
    user = update.effective_user
    args = context.args
    
    get_user_or_create(user.id, user.username, user.first_name)
    
    if not args or not args[0]:
        await update.message.reply_text(
            "🎟️ <b>REDEEM KODE VIP</b>\n\n"
            "Cara pakai:\n"
            "<code>/redeem VIP-XXXXX</code>\n\n"
            "Masukkan kode VIP yang Anda miliki untuk mendapatkan akses VIP.",
            parse_mode=ParseMode.HTML
        )
        return
    
    redeem_code = args[0].upper().strip()
    
    with get_db() as conn:
        cursor = conn.cursor()
        
        # Cari kode redeem
        cursor.execute("SELECT * FROM redeem_codes WHERE code = ?", (redeem_code,))
        code_data = cursor.fetchone()
        
        if not code_data:
            await update.message.reply_text(
                "❌ <b>Kode Tidak Valid!</b>\n\n"
                f"Kode <code>{redeem_code}</code> tidak ditemukan.",
                parse_mode=ParseMode.HTML
            )
            return
        
        # Cek apakah user ini sudah pernah klaim kode ini
        cursor.execute("SELECT id FROM redeem_history WHERE code_id = ? AND user_id = ?", (code_data['id'], user.id))
        if cursor.fetchone():
            await update.message.reply_text(
                "❌ <b>Anda Sudah Klaim!</b>\n\n"
                f"Anda sudah pernah menggunakan kode <code>{redeem_code}</code> sebelumnya.",
                parse_mode=ParseMode.HTML
            )
            return

        # Cek apakah kuota user sudah habis
        cursor.execute("SELECT COUNT(*) as total FROM redeem_history WHERE code_id = ?", (code_data['id'],))
        current_redeems = cursor.fetchone()['total']
        if current_redeems >= code_data['max_redeems']:
            await update.message.reply_text(
                "❌ <b>Kuota Habis!</b>\n\n"
                f"Maaf, kode <code>{redeem_code}</code> sudah mencapai batas maksimal penggunaan.",
                parse_mode=ParseMode.HTML
            )
            return
        
        # Cek apakah expired
        expires_at = datetime.fromisoformat(code_data['expires_at'])
        if datetime.now() > expires_at:
            await update.message.reply_text(
                "❌ <b>Kode Sudah Expired!</b>\n\n"
                f"Kode <code>{redeem_code}</code> sudah melewati batas waktu.",
                parse_mode=ParseMode.HTML
            )
            return
        
        # Proses redeem - aktivkan VIP Limited
        now = datetime.now()
        vip_limited_until = now + timedelta(days=code_data['days'])
        max_views = code_data['max_views']
        
        # Catat di history
        cursor.execute("""
            INSERT INTO redeem_history (code_id, user_id, redeemed_at)
            VALUES (?, ?, ?)
        """, (code_data['id'], user.id, now.isoformat()))
        
        # Aktivkan VIP Limited untuk user
        cursor.execute("""
            UPDATE users 
            SET vip_limited_until = ?, 
                vip_limited_views = 0,
                vip_limited_total_views = ?
            WHERE user_id = ?
        """, (vip_limited_until.isoformat(), max_views, user.id))
        
        conn.commit()
        
        # [FIREBASE] Sync history ke Firebase (sebagai koleksi sub atau tersendiri)
        firebase_sync._safe_sync('redeem_history', f"{code_data['id']}_{user.id}", {
            'code_id': code_data['id'],
            'code': redeem_code,
            'user_id': user.id,
            'user_name': user.first_name,
            'redeemed_at': now.isoformat()
        })
        
        firebase_sync.sync_user_vip_update(
            user.id,
            vip_until_iso=None,
            vip_limited_until_iso=vip_limited_until.isoformat(),
            vip_limited_views=0,
            vip_limited_total_views=max_views
        )
    
    await update.message.reply_text(
        "✅ <b>KODE BERHASIL DI-REDEEM!</b>\n\n"
        f"🎟️ Kode: <code>{redeem_code}</code>\n"
        f"📦 Paket: VIP Limited {code_data['days']} Hari\n"
        f"👁 Kuota: {max_views}x tonton video VIP\n"
        f"📅 Berlaku sampai: {vip_limited_until.strftime('%d %B %Y %H:%M')}\n\n"
        "Selamat menikmati video VIP! 🎉",
        parse_mode=ParseMode.HTML
    )
    
    # Notifikasi ke admin
    for admin_id in ADMIN_IDS:
        try:
            await context.bot.send_message(
                chat_id=admin_id,
                text=(
                    f"🎟️ <b>KODE REDEEMED</b>\n\n"
                    f"👤 User: [{user.first_name}](tg://user?id={user.id})\n"
                    f"🆔 ID: <code>{user.id}</code>\n"
                    f"🎟️ Kode: <code>{redeem_code}</code>\n"
                    f"📦 VIP Limited {code_data['days']}H ({max_views}x)"
                ),
                parse_mode=ParseMode.HTML
            )
        except:
            pass

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /start"""
    user = update.effective_user
    args = context.args
    
    await delete_previous_message(update, context)
    
    logger.info(f"Start command from user {user.id} with args: {args}")
    
    get_user_or_create(user.id, user.username, user.first_name)
    
    if args and args[0]:
        video_code = args[0]
        logger.info(f"Processing video code: {video_code}")
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM videos WHERE code = ?", (video_code,))
            video = cursor.fetchone()
            
            if video:
                logger.info(f"Video found: {video['id']}, access_type: {video['access_type']}")
                
                cursor.execute("UPDATE videos SET view_count = view_count + 1 WHERE id = ?", (video['id'],))
                conn.commit()
                
                # Cek akses
                can_access = False
                access_reason = "FREE"
                
                if is_admin(user.id) or is_vip_regular(user.id):
                    can_access = True
                    access_reason = "ADMIN_OR_VIP"
                elif is_vip_limited(user.id):
                    can_access = True
                    access_reason = "VIP_LIMITED"
                else:
                    # User FREE - Berikan jatah 1 video per hari
                    with get_db() as conn_check:
                        cursor_check = conn_check.cursor()
                        cursor_check.execute("""
                            SELECT COUNT(*) as today_views FROM stats 
                            WHERE user_id = ? AND action = 'VIEW' 
                            AND timestamp >= date('now')
                        """, (user.id,))
                        today_views = cursor_check.fetchone()['today_views']
                        
                        if today_views < 1:
                            can_access = True
                            access_reason = "FREE_DAILY_QUOTA"
                        else:
                            can_access = False
                            access_reason = "QUOTA_EXHAUSTED"
                
                if can_access:
                    # Catat statistik
                    metadata = access_reason
                    if access_reason == "VIP_LIMITED":
                        # Kurangi sisa views untuk VIP Limited
                        cursor.execute("""
                            UPDATE users 
                            SET vip_limited_views = vip_limited_views + 1 
                            WHERE user_id = ?
                        """, (user.id,))
                    
                    cursor.execute("""
                        INSERT INTO stats (video_id, user_id, action, metadata)
                        VALUES (?, ?, ?, ?)
                    """, (video['id'], user.id, 'VIEW', metadata))
                    conn.commit()
                    
                    # Terapkan proteksi konten sesuai setting admin
                    is_protected = (get_setting('protect_content') == 'ON')
                    
                    try:
                        if video['file_type'] == 'video':
                            await context.bot.send_video(
                                chat_id=update.effective_chat.id,
                                video=video['file_id'],
                                caption=video['caption'],
                                protect_content=is_protected
                            )
                        else:
                            await context.bot.send_document(
                                chat_id=update.effective_chat.id,
                                document=video['file_id'],
                                caption=video['caption'],
                                protect_content=is_protected
                            )
                        return
                    except Exception as e:
                        logger.error(f"Error sending video: {e}")
                        await update.message.reply_text("❌ Gagal mengirim video. Silakan coba lagi nanti.")
                        return
                else:
                    if access_reason == "QUOTA_EXHAUSTED":
                        text = (
                            "🔔 <b>JATAH HARIAN HABIS</b>\n\n"
                            "Sebagai user gratis (FREE), Anda hanya mendapatkan jatah tonton <b>1 video per hari</b>.\n\n"
                            "Ingin nonton sepuasnya tanpa batas?\n"
                            "Silakan upgrade ke <b>VIP Regular</b> sekarang!"
                        )
                    elif is_vip_limited(user.id): # This case shouldn't be hit with can_access check above but for safety
                         text = "🔒 Kuota VIP Limited Anda telah habis!\n\nSilakan upgrade ke VIP Regular untuk akses tanpa batas."
                    else:
                        text = "🔒 Video Ini Khusus Member VIP\n\nSilakan membeli akses VIP untuk menonton video ini."
                    
                    keyboard = [[InlineKeyboardButton("💎 Beli VIP", callback_data="buy_vip")]]
                    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
                    return
            else:
                await update.message.reply_text("❌ Video Tidak Ditemukan\n\nKode yang Anda masukkan tidak valid atau video telah dihapus.")
                return
    
    welcome_text = (
        f"👋 Hallo {user.first_name}!\n\n"
        f"Selamat Bergabung di Short Drama Team DL\n\n"
        f"Gunakan perintah /status untuk melihat status membership Anda.\n"
        f"Ketik /vip untuk info pembelian VIP.\n"
        f"Ketik /cari untuk mencari video.\n"
        f"Klik link video untuk memutar langsung."
    )
    
    keyboard = [
        [InlineKeyboardButton("💎 STATUS MEMBERSHIP", callback_data="vip_status")],
        [InlineKeyboardButton("🛍️ BELI PAKET VIP", callback_data="buy_vip")],
        [InlineKeyboardButton("🎁 REDEEM KODE VIP", callback_data="user_redeem_start")],
        [InlineKeyboardButton("🔍 CARI VIDEO DRAMA", callback_data="search_again")],
        [InlineKeyboardButton("👨‍💻 KONTAK ADMIN", url=f"tg://user?id={ADMIN_IDS[0]}")]
    ]
    
    if is_admin(user.id):
        keyboard.append([InlineKeyboardButton("⚙️ Panel Admin", callback_data="admin_panel")])
    
    is_protected = (get_setting('protect_content') == 'ON')
    msg = await update.message.reply_text(welcome_text, reply_markup=InlineKeyboardMarkup(keyboard), protect_content=is_protected)
    context.user_data['last_msg_id'] = msg.message_id

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /status - menampilkan status user"""
    user = update.effective_user
    
    await delete_previous_message(update, context)
    
    logger.info(f"Status command from user {user.id} in {update.effective_chat.type}")
    
    status = get_user_status(user.id)
    
    if not status:
        await update.message.reply_text("❌ Data user tidak ditemukan!")
        return
    
    pending_text = ""
    if status['pending_payments'] > 0:
        pending_text = f"\n⏳ Pembayaran Pending: {status['pending_payments']}"
    
    if status['vip_overall'] == 'REGULAR':
        message = (
            f"👤 STATUS MEMBERSHIP ANDA\n\n"
            f"🆔 User ID: {user.id}\n"
            f"📛 Nama: {user.first_name}\n"
            f"📱 Username: @{user.username or 'None'}\n\n"
            f"{status['vip_icon']} Status VIP: REGULAR AKTIF\n"
            f"💎 Tipe: VIP Regular (Full Akses)\n"
            f"📅 Berlaku sampai: {status['expiry_date']}\n"
            f"⏳ Sisa waktu: {status['days_left']} hari {status['hours_left']} jam\n"
            f"{pending_text}"
        )
    elif status['vip_overall'] == 'LIMITED':
        total_views = status.get('vip_limited_total_views', 2)
        views_left = status.get('limited_views_left', 0)
        message = (
            f"👤 STATUS MEMBERSHIP ANDA\n\n"
            f"🆔 User ID: {user.id}\n"
            f"📛 Nama: {user.first_name}\n"
            f"📱 Username: @{user.username or 'None'}\n\n"
            f"{status['vip_limited_icon']} Status VIP: LIMITED AKTIF\n"
            f"🔰 Tipe: VIP Limited ({total_views}x Lihat)\n"
            f"📅 Berlaku sampai: {status['limited_expiry_date']}\n"
            f"⏳ Sisa waktu: {status['limited_days_left']} hari {status['limited_hours_left']} jam\n"
            f"👁 Sisa kuota lihat: {views_left} dari {total_views} kali\n"
            f"{pending_text}"
        )
    else:
        message = (
            f"👤 STATUS MEMBERSHIP ANDA\n\n"
            f"🆔 User ID: {user.id}\n"
            f"📛 Nama: {user.first_name}\n"
            f"📱 Username: @{user.username or 'None'}\n\n"
            f"❌ Status VIP: TIDAK AKTIF\n"
            f"💎 Tipe: Free User\n"
            f"{pending_text}\n\n"
            f"💡 Ingin jadi VIP?\n"
            f"Klik tombol di bawah untuk membeli akses VIP."
        )
    
    is_protected = (get_setting('protect_content') == 'ON')
    msg = await update.message.reply_text(message, reply_markup=InlineKeyboardMarkup(keyboard), protect_content=is_protected)
    context.user_data['last_msg_id'] = msg.message_id

async def vip_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /vip - info pembelian VIP"""
    user = update.effective_user
    
    await delete_previous_message(update, context)
    
    logger.info(f"VIP command from user {user.id} in {update.effective_chat.type}")
    
    get_user_or_create(user.id, user.username, user.first_name)
    
    status = get_user_status(user.id)
    
    if status and status['vip_overall'] == 'REGULAR':
        message = (
            f"💎 ANDA SUDAH VIP REGULAR\n\n"
            f"Status: AKTIF ✅\n"
            f"Berlaku sampai: {status['expiry_date']}\n"
            f"Sisa waktu: {status['days_left']} hari {status['hours_left']} jam\n\n"
            f"Anda memiliki akses penuh ke semua video VIP!"
        )
        keyboard = [[InlineKeyboardButton("📊 Cek Status", callback_data="vip_status")]]
    elif status and status['vip_overall'] == 'LIMITED':
        total_views = status.get('vip_limited_total_views', 2)
        views_left = status.get('limited_views_left', 0)
        message = (
            f"🔰 ANDA SUDAH VIP LIMITED\n\n"
            f"Status: AKTIF ✅\n"
            f"Berlaku sampai: {status['limited_expiry_date']}\n"
            f"Sisa kuota: {views_left} dari {total_views} kali\n\n"
            f"Anda bisa upgrade ke VIP Regular untuk akses tanpa batas!"
        )
        keyboard = [
            [InlineKeyboardButton("💎 Upgrade ke VIP Regular", callback_data="buy_vip_regular")],
            [InlineKeyboardButton("📊 Cek Status", callback_data="vip_status")]
        ]
    else:
        message = (
            f"💎 VIP MEMBERSHIP\n\n"
            f"📌 Pilih Paket:\n\n"
            f"🔰 VIP LIMITED (Coba-coba)\n"
            f"• 1 Hari - Rp 1.000 (2x lihat)\n"
            f"• 3 Hari - Rp 3.000 (6x lihat)\n\n"
            f"💎 VIP REGULAR (Full Akses)\n"
            f"• 7 Hari - Rp {7 * PRICE_PER_DAY:,}\n"
            f"• 14 Hari - Rp {14 * PRICE_PER_DAY:,}\n"
            f"• 30 Hari - Rp {30 * PRICE_PER_DAY:,}\n"
            f"• 60 Hari - Rp {60 * PRICE_PER_DAY:,}\n"
            f"• 90 Hari - Rp {90 * PRICE_PER_DAY:,}\n\n"
            f"✅ Keuntungan VIP:\n"
            f"• Akses semua video VIP\n"
            f"• Download tanpa batas\n"
            f"• Konten eksklusif"
        )
        keyboard = [[InlineKeyboardButton("💰 Beli VIP Sekarang", callback_data="buy_vip")]]
    
    keyboard.append([InlineKeyboardButton("📞 Kontak Admin", url=f"tg://user?id={ADMIN_IDS[0]}")])
    
    is_protected = (get_setting('protect_content') == 'ON')
    msg = await update.message.reply_text(message, reply_markup=InlineKeyboardMarkup(keyboard), protect_content=is_protected)
    context.user_data['last_msg_id'] = msg.message_id

# ===================== SEARCH COMMAND HANDLER =====================
async def privacy_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /privacy - Menampilkan kebijakan privasi atau toggle proteksi untuk admin"""
    user = update.effective_user
    await delete_previous_message(update, context)
    is_protected = (get_setting('protect_content') == 'ON')
    
    if is_admin(user.id):
        # Jika admin, beri info + tombol toggle
        text = (
            "🛡️ <b>PENGATURAN PRIVASI (ADMIN)</b>\n\n"
            f"Status Proteksi Konten: <b>{'AKTIF' if is_protected else 'NONAKTIF'}</b>\n\n"
            "Jika AKTIF, fitur forward dan simpan konten akan dimatikan untuk semua video.\n\n"
            "Pilih tindakan:"
        )
        keyboard.append([InlineKeyboardButton("⚙️ Buka Panel Admin", callback_data="admin_panel")])
        
        is_protected = (get_setting('protect_content') == 'ON')
        msg = await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
        context.user_data['last_msg_id'] = msg.message_id
    else:
        # Jika user biasa, beri info kebijakan privasi
        status_text = "dilindungi (tidak dapat di-forward)" if is_protected else "tidak dilindungi (dapat di-forward)"
        text = (
            "🛡️ <b>KEBIJAKAN PRIVASI</b>\n\n"
            "1. <b>Data Pengguna:</b> Kami hanya menyimpan ID Telegram, Username, dan Nama Anda untuk keperluan manajemen membership VIP.\n"
            "2. <b>Keamanan Konten:</b> Saat ini konten di bot ini " + status_text + ".\n"
            "3. <b>Data Transaksi:</b> Bukti pembayaran yang Anda kirimkan hanya digunakan untuk verifikasi manual oleh admin.\n\n"
            "<i>Kami berkomitmen menjaga privasi data Anda. Jika ada keluhan, silakan hubungi Admin.</i>"
        )
        msg = await update.message.reply_text(text, parse_mode=ParseMode.HTML)
        context.user_data['last_msg_id'] = msg.message_id

async def search_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /cari"""
    user = update.effective_user
    await delete_previous_message(update, context)
    chat_type = update.effective_chat.type
    
    logger.info(f"Search command from user {user.id} in {chat_type}")
    
    last_search = context.user_data.get('last_search_time', 0)
    current_time = datetime.now().timestamp()
    
    if current_time - last_search < 3:
        await update.message.reply_text("⏳ Mohon tunggu 3 detik sebelum mencari lagi.")
        return
    
    args = context.args
    
    if args:
        keyword = ' '.join(args).strip()
        context.user_data['last_search_time'] = current_time
        await perform_search(update, context, keyword, page=1)
        return
    
    context.user_data['waiting_search'] = True
    context.user_data['last_search_time'] = current_time
    
    msg = await update.message.reply_text(
        "🔎 *MODE PENCARIAN AKTIF*\n\n"
        "Silakan kirim judul drama yang ingin dicari.\n\n"
        "Contoh:\n"
        "`Cinta Terlarang`\n"
        "`Nenek`\n\n"
        "Ketik /cancel untuk membatalkan pencarian.",
        parse_mode=ParseMode.MARKDOWN
    )
    context.user_data['last_msg_id'] = msg.message_id

# ===================== DELETE VIDEO COMMAND =====================
async def hapus_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /hapus [kode_atau_link] - Menghapus video dari database"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Anda bukan admin!")
        return
        
    args = context.args
    if not args:
        await update.message.reply_text(
            "⚠️ *Gunakan format:* `/hapus [KODE_VIDEO atau LINK]`\n\n"
            "Contoh:\n"
            "• `/hapus MKV123ABC`\n"
            "• `/hapus https://t.me/ShortTeamDl_bot?start=MKV123ABC`",
            parse_mode=ParseMode.MARKDOWN
        )
        return
        
    input_text = args[0].strip()
    video_code = input_text
    
    # Ekstrak kode jika input berupa link lengkap
    if "start=" in input_text:
        video_code = input_text.split("start=")[1]
    elif "/" in input_text and "=" not in input_text:
        video_code = input_text.split("/")[-1]
    
    # Bersihkan jika ada teks tambahan di belakang kode (misal hasil copy link)
    if "&" in video_code:
        video_code = video_code.split("&")[0]
        
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM videos WHERE code = ?", (video_code,))
        video = cursor.fetchone()
        
        if not video:
            await update.message.reply_text(
                f"❌ *Gagal!* Video dengan kode `{video_code}` tidak ditemukan.",
                parse_mode=ParseMode.MARKDOWN
            )
            return

        video_id = video['id']
        caption = video['caption']
        
        # Konfirmasi hapus
        keyboard = [
            [
                InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"video_delete_confirm_{video_id}"),
                InlineKeyboardButton("❌ Batal", callback_data="no_action")
            ]
        ]
        
        await update.message.reply_text(
            f"⚠️ *KONFIRMASI HAPUS VIDEO*\n\n"
            f"🎬 Judul: `{caption}`\n"
            f"📌 Kode: `{video_code}`\n\n"
            f"Yakin ingin menghapus video ini? Video tidak akan bisa diakses lagi melalui link dan tidak akan muncul di pencarian.",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )

async def perform_search(update: Update, context: ContextTypes.DEFAULT_TYPE, keyword: str, page: int = 1):
    """Fungsi utama untuk melakukan pencarian dengan pagination"""
    
    if len(keyword) < 3:
        await update.message.reply_text("❌ Keyword terlalu pendek.\nMinimal 3 karakter.")
        return
    
    results = search_videos(keyword)
    
    if not results:
        # KIRIM LAPORAN OTOMATIS KE GRUP ADMIN (TOPIK)
        REPORT_GROUP_ID = -1003857149032
        REPORT_THREAD_ID = 2062
        
        try:
            user = update.effective_user
            await context.bot.send_message(
                chat_id=REPORT_GROUP_ID,
                message_thread_id=REPORT_THREAD_ID,
                text=(
                    f"🔍 <b>PENCARIAN GAGAL</b>\n\n"
                    f"👤 User: {user.first_name} (<code>{user.id}</code>)\n"
                    f"📝 Keyword: <code>{keyword}</code>\n"
                    f"⚠️ Status: Tidak ditemukan di database."
                ),
                parse_mode=ParseMode.HTML
            )
        except Exception as e:
            logger.error(f"Gagal kirim laporan search ke admin: {e}")

        # TAMPILKAN PESAN KE USER DENGAN TOMBOL LAPOR
        keyboard = [[InlineKeyboardButton("📢 LAPORKAN KE ADMIN", url="https://t.me/MiniDramaSubIndo/18521")]]
        
        await update.message.reply_text(
            f"❌ <b>Video tidak ditemukan!</b>\n\n"
            f"Maaf, video dengan kata kunci '<code>{keyword}</code>' belum tersedia.\n"
            f"Permintaan Anda sudah diteruskan ke tim admin.",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
        return
    
    per_page = 5
    paginated = paginate_results(results, page, per_page)
    
    context.user_data['last_search_keyword'] = keyword
    context.user_data['search_results'] = results
    context.user_data['search_per_page'] = per_page
    context.user_data['last_search_page'] = page
    
    result_text = (
        f"🎬 *HASIL PENCARIAN: {keyword}*\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"📊 {paginated['start_idx']}-{paginated['start_idx'] + len(paginated['items']) - 1} dari {paginated['total_items']} video\n"
        f"━━━━━━━━━━━━━━━━━━━\n\n"
    )
    
    keyboard = []
    
    for i, video in enumerate(paginated['items'], paginated['start_idx']):
        vip_icon = "🔒" if video['access_type'] == 'VIP' else "🔓"
        title = video['caption'] if video['caption'] else "Tanpa Judul"
        if len(title) > 50:
            title = title[:50] + "..."
        
        result_text += f"{i}. {vip_icon} *{title}*\n\n"
        
        button_text = f"{vip_icon} {i}. {title}"
        if len(button_text) > 60:
            button_text = button_text[:57] + "..."
            
        keyboard.append([
            InlineKeyboardButton(button_text, callback_data=f"search_result_{video['id']}")
        ])
    
    nav_buttons = []
    
    if paginated['has_prev']:
        nav_buttons.append(
            InlineKeyboardButton("◀️ Sebelumnya", callback_data=f"sp_{page-1}")
        )
    
    nav_buttons.append(
        InlineKeyboardButton(f"📄 {page}/{paginated['total_pages']}", callback_data="no_action")
    )
    
    if paginated['has_next']:
        nav_buttons.append(
            InlineKeyboardButton("Berikutnya ▶️", callback_data=f"sp_{page+1}")
        )
    
    if nav_buttons:
        keyboard.append(nav_buttons)
    
    keyboard.append([InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")])
    
    is_protected = (get_setting('protect_content') == 'ON')
    
    msg = await update.message.reply_text(
        result_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode=ParseMode.MARKDOWN,
        protect_content=is_protected
    )
    context.user_data['last_msg_id'] = msg.message_id
    
    context.user_data.pop('waiting_search', None)

# ===================== SEARCH CALLBACK HANDLERS =====================
async def search_page_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk navigasi halaman pencarian"""
    query = update.callback_query
    await query.answer()
    
    data = query.data
    # sp_{page}
    parts = data.split('_')
    page = int(parts[1])
    
    keyword = context.user_data.get('last_search_keyword')
    
    if not keyword:
        await query.edit_message_text(
            "⏳ Sesi pencarian telah berakhir.\n"
            "Silakan lakukan pencarian baru dengan /cari"
        )
        return

    context.user_data['last_search_page'] = page
    
    if 'search_results' in context.user_data:
        results = context.user_data['search_results']
    else:
        results = search_videos(keyword)
        context.user_data['search_results'] = results
    
    if not results:
        await safe_edit_message(
            query,
            f"❌ Tidak ada hasil untuk *{keyword}*",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")
            ]])
        )
        return
    
    per_page = context.user_data.get('search_per_page', 5)
    paginated = paginate_results(results, page, per_page)
    
    result_text = (
        f"🎬 *HASIL PENCARIAN: {keyword}*\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"📊 {paginated['start_idx']}-{paginated['start_idx'] + len(paginated['items']) - 1} dari {paginated['total_items']} video\n"
        f"━━━━━━━━━━━━━━━━━━━\n\n"
    )
    
    keyboard = []
    
    for i, video in enumerate(paginated['items'], paginated['start_idx']):
        vip_icon = "🔒" if video['access_type'] == 'VIP' else "🔓"
        title = video['caption'] if video['caption'] else "Tanpa Judul"
        if len(title) > 50:
            title = title[:50] + "..."
        
        result_text += f"{i}. {vip_icon} *{title}*\n\n"
        
        button_text = f"{vip_icon} {i}. {title}"
        if len(button_text) > 60:
            button_text = button_text[:57] + "..."
            
        keyboard.append([
            InlineKeyboardButton(button_text, callback_data=f"search_result_{video['id']}")
        ])
    
    nav_buttons = []
    encoded_keyword = keyword.replace(' ', '_')
    
    if paginated['has_prev']:
        nav_buttons.append(
            InlineKeyboardButton("◀️ Sebelumnya", callback_data=f"sp_{page-1}")
        )
    
    nav_buttons.append(
        InlineKeyboardButton(f"📄 {page}/{paginated['total_pages']}", callback_data="no_action")
    )
    
    if paginated['has_next']:
        nav_buttons.append(
            InlineKeyboardButton("Berikutnya ▶️", callback_data=f"sp_{page+1}")
        )
    
    if nav_buttons:
        keyboard.append(nav_buttons)
    
    keyboard.append([InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")])
    
    await safe_edit_message(
        query,
        result_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode=ParseMode.MARKDOWN
    )

async def search_result_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk tombol hasil pencarian"""
    query = update.callback_query
    await query.answer()
    
    user = update.effective_user
    video_id = int(query.data.split('_')[2])
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
        video = cursor.fetchone()
        
        if not video:
            await query.edit_message_text("❌ Video tidak ditemukan!")
            return
        
        can_access = video['access_type'] == 'FREE' or can_access_vip(user.id)
        
        vip_icon = "🔒" if video['access_type'] == 'VIP' else "🔓"
        detail_text = (
            f"🎬 *{video['caption']}*\n"
            f"━━━━━━━━━━━━━━━━━━━\n"
            f"🔓 Tipe: {vip_icon} {video['access_type']}\n"
            f"👤 Uploader: {video['uploader_name']}\n"
            f"📅 Upload: {video['uploaded_at'][:10]}\n"
            f"━━━━━━━━━━━━━━━━━━━\n"
        )
        
        keyboard = []
        
        if can_access:
            video_link = generate_video_link(video['code'])
            keyboard.append([InlineKeyboardButton("🎬 Tonton Video", url=video_link)])
        else:
            status = get_user_status(user.id)
            if status and status['vip_overall'] == 'LIMITED' and status.get('limited_views_left', 0) <= 0:
                detail_text += f"\n🔒 *Kuota VIP Limited Anda habis!*\n\nSilakan upgrade ke VIP Regular."
            else:
                detail_text += f"\n🔒 *Video ini khusus member VIP.*\n\nSilakan upgrade untuk menonton."
            keyboard.append([InlineKeyboardButton("💎 Beli VIP", callback_data="buy_vip")])
        
        if 'last_search_page' in context.user_data and 'last_search_keyword' in context.user_data:
            keyword = context.user_data.get('last_search_keyword', '')
            page = context.user_data.get('last_search_page', 1)
            encoded_keyword = keyword.replace(' ', '_')
            keyboard.append([
                InlineKeyboardButton("🔍 Kembali ke Hasil", callback_data=f"sp_{page}")
            ])
        else:
            keyboard.append([InlineKeyboardButton("🔍 Kembali ke Hasil", callback_data="back_to_search")])
        
        if 'last_search_keyword' in context.user_data:
            context.user_data['temp_last_search'] = context.user_data.get('last_search_keyword')
        
        await safe_edit_message(
            query,
            detail_text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )

async def back_to_search_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk tombol kembali ke hasil pencarian"""
    query = update.callback_query
    await query.answer()
    
    keyword = context.user_data.get('temp_last_search') or context.user_data.get('last_search_keyword')
    
    if not keyword:
        await safe_edit_message(
            query,
            "❌ Sesi pencarian telah berakhir.\nSilakan cari lagi dengan /cari",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")
            ]])
        )
        return
    
    await perform_search_from_callback(query, context, keyword, page=1)

async def perform_search_from_callback(query, context: ContextTypes.DEFAULT_TYPE, keyword: str, page: int = 1):
    """Fungsi untuk melakukan pencarian dari callback (edit pesan)"""
    
    context.user_data['last_search_page'] = page
    
    if 'search_results' in context.user_data:
        results = context.user_data['search_results']
    else:
        results = search_videos(keyword)
        context.user_data['search_results'] = results
    
    if not results:
        await safe_edit_message(
            query,
            f"❌ Tidak ada hasil untuk *{keyword}*",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")
            ]])
        )
        return
    
    per_page = context.user_data.get('search_per_page', 5)
    paginated = paginate_results(results, page, per_page)
    
    result_text = (
        f"🎬 *HASIL PENCARIAN: {keyword}*\n"
        f"━━━━━━━━━━━━━━━━━━━\n"
        f"📊 {paginated['start_idx']}-{paginated['start_idx'] + len(paginated['items']) - 1} dari {paginated['total_items']} video\n"
        f"━━━━━━━━━━━━━━━━━━━\n\n"
    )
    
    keyboard = []
    
    for i, video in enumerate(paginated['items'], paginated['start_idx']):
        vip_icon = "🔒" if video['access_type'] == 'VIP' else "🔓"
        title = video['caption'] if video['caption'] else "Tanpa Judul"
        if len(title) > 50:
            title = title[:50] + "..."
        
        result_text += f"{i}. {vip_icon} *{title}*\n\n"
        
        button_text = f"{vip_icon} {i}. {title}"
        if len(button_text) > 60:
            button_text = button_text[:57] + "..."
            
        keyboard.append([
            InlineKeyboardButton(button_text, callback_data=f"search_result_{video['id']}")
        ])
    
    nav_buttons = []
    encoded_keyword = keyword.replace(' ', '_')
    
    if paginated['has_prev']:
        nav_buttons.append(
            InlineKeyboardButton("◀️ Sebelumnya", callback_data=f"sp_{page-1}")
        )
    
    nav_buttons.append(
        InlineKeyboardButton(f"📄 {page}/{paginated['total_pages']}", callback_data="no_action")
    )
    
    if paginated['has_next']:
        nav_buttons.append(
            InlineKeyboardButton("Berikutnya ▶️", callback_data=f"sp_{page+1}")
        )
    
    if nav_buttons:
        keyboard.append(nav_buttons)
    
    keyboard.append([InlineKeyboardButton("🔍 Cari Lagi", callback_data="search_again")])
    
    await safe_edit_message(
        query,
        result_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode=ParseMode.MARKDOWN
    )

async def search_again_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk tombol 'Cari Lagi'"""
    query = update.callback_query
    await query.answer()
    
    context.user_data['waiting_search'] = True
    
    await safe_edit_message(
        query,
        "🔎 *MODE PENCARIAN AKTIF*\n\n"
        "Silakan kirim judul drama yang ingin dicari.\n\n"
        "Contoh: `Cinta Terlarang`\n\n"
        "Ketik /cancel untuk membatalkan pencarian.",
        parse_mode=ParseMode.MARKDOWN
    )

# ===================== VIDEO HANDLERS =====================
async def handle_video(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk upload video (Admin, Bot, atau Grup Sumber)"""
    user = update.effective_user
    chat_id = update.effective_chat.id
    
    # Cek apakah dari grup sumber terdaftar
    is_from_source = False
    thread_id = update.message.message_thread_id
    
    with get_db() as conn:
        cursor = conn.cursor()
        if thread_id:
            cursor.execute("SELECT id FROM source_groups WHERE chat_id = ? AND thread_id = ? AND is_active = 1", (chat_id, thread_id))
        else:
            cursor.execute("SELECT id FROM source_groups WHERE chat_id = ? AND (thread_id IS NULL OR thread_id = 0) AND is_active = 1", (chat_id,))
            
        if cursor.fetchone():
            is_from_source = True
            
    # Cek izin pengirim
    # Jika berasal dari sumber grup terdaftar ATAU pengirim adalah Admin, maka proses
    if not is_from_source and not is_admin(user.id if user else 0):
        return
    
    if update.message.video:
        file_id = update.message.video.file_id
        file_type = 'video'
        logger.info(f"Video received: {file_id}")
    else:
        await update.message.reply_text("❌ Kirim file video!")
        return
    
    caption = update.message.caption
    if not caption or caption.strip() == "":
        caption = "Tanpa Judul"
    
    # Cek apakah judul sudah terdaftar
    if caption != "Tanpa Judul":
        existing_video = get_video_by_caption(caption)
        if existing_video:
            video_link = generate_video_link(existing_video['code'])
            await update.message.reply_text(
                f"⚠️ *Judul sudah terdaftar!*\n\n"
                f"Judul: `{caption}`\n"
                f"Status: Sudah ada di database\n\n"
                f"🔗 Link: {video_link}",
                parse_mode=ParseMode.MARKDOWN
            )
            return
            
    video_code = generate_video_code()
    while True:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM videos WHERE code = ?", (video_code,))
            if not cursor.fetchone():
                break
        video_code = generate_video_code()
    
    uploader_name = get_user_display_name(user)
    waktu_sekarang = datetime.now().strftime("%d-%m-%Y %H:%M")
    
    # Tentukan akses type (Otomatis VIP jika dari sumber grup)
    default_access = 'VIP' if is_from_source else 'FREE'
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO videos (
                code, file_id, caption, file_type, 
                uploaded_by, uploader_name, access_type, view_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """, (video_code, file_id, caption, file_type, user.id, uploader_name, default_access))
        video_id = cursor.lastrowid
        conn.commit()
        
        # [FIREBASE] Sync video baru ke Firestore
        firebase_sync.sync_video_create(
            video_id=video_id, video_code=video_code,
            file_id=file_id, caption=caption, file_type=file_type,
            uploaded_by=user.id, uploader_name=uploader_name,
            bot_username=BOT_USERNAME
        )
        
        backup_caption = format_backup_caption(
            video_code=video_code,
            caption=caption,
            uploader_name=uploader_name,
            waktu=waktu_sekarang,
            access_type="free / vip sesuai setingan setelah upload"
        )
        
        try:
            backup_msg = await context.bot.send_video(
                chat_id=BACKUP_CHANNEL_ID,
                video=file_id,
                caption=backup_caption
            )
            
            cursor.execute("UPDATE videos SET backup_message_id = ? WHERE id = ?", (backup_msg.message_id, video_id))
            # [FIREBASE] Sync backup_message_id
            firebase_sync.sync_video_update_ids(video_code, backup_message_id=backup_msg.message_id)
            logger.info(f"Video backed up to channel: {backup_msg.message_id}")
        except Exception as e:
            logger.error(f"Gagal kirim ke backup channel: {e}")
        
        try:
            log_caption = backup_caption + "\n\n🆔 ID Video: " + str(video_id)
            log_keyboard = create_video_keyboard(video_id, "FREE")
            
            log_msg = await context.bot.send_video(
                chat_id=LOG_CHANNEL_ID,
                video=file_id,
                caption=log_caption,
                reply_markup=log_keyboard
            )
            
            cursor.execute("UPDATE videos SET log_message_id = ? WHERE id = ?", (log_msg.message_id, video_id))
            conn.commit()
            # [FIREBASE] Sync log_message_id
            firebase_sync.sync_video_update_ids(video_code, log_message_id=log_msg.message_id)
            logger.info(f"Video logged to channel: {log_msg.message_id}")
        except Exception as e:
            logger.error(f"Gagal kirim ke log channel: {e}")
    
    video_link = generate_video_link(video_code)
    
    if is_from_source:
        await update.message.reply_text(
            f"✅ <b>Video Terdeteksi & Terdaftar!</b>\n\n"
            f"🔗 Link: {video_link}\n"
            f"📝 Judul: {caption}\n"
            f"💎 Akses: <b>VIP (Otomatis)</b>\n"
            f"📌 Kode: <code>{video_code}</code>",
            parse_mode=ParseMode.HTML
        )
        return

    await update.message.reply_text(
        f"✅ Video Berhasil Diupload!\n\n"
        f"🔗 Link Video:\n"
        f"{video_link}\n\n"
        f"📝 Judul: {caption}\n"
        f"📌 Kode: {video_code}\n"
        f"👤 Uploader: {uploader_name}\n"
        f"⏰ Waktu: {waktu_sekarang}\n\n"
        f"Pilih tipe akses untuk video ini:",
        reply_markup=InlineKeyboardMarkup([
            [
                InlineKeyboardButton("🔓 FREE", callback_data=f"video_set_free_{video_id}"),
                InlineKeyboardButton("💎 VIP", callback_data=f"video_set_vip_{video_id}")
            ]
        ])
    )

async def handle_document(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk upload document (video sebagai file)"""
    user = update.effective_user
    chat_id = update.effective_chat.id
    
    # Cek apakah dari grup sumber terdaftar
    is_from_source = False
    thread_id = update.message.message_thread_id
    
    with get_db() as conn:
        cursor = conn.cursor()
        if thread_id:
            cursor.execute("SELECT id FROM source_groups WHERE chat_id = ? AND thread_id = ? AND is_active = 1", (chat_id, thread_id))
        else:
            cursor.execute("SELECT id FROM source_groups WHERE chat_id = ? AND (thread_id IS NULL OR thread_id = 0) AND is_active = 1", (chat_id,))
            
        if cursor.fetchone():
            is_from_source = True

    # Cek izin pengirim
    # Jika berasal dari sumber grup terdaftar ATAU pengirim adalah Admin, maka proses
    if not is_from_source and not is_admin(user.id if user else 0):
        return
    
    if update.message.document and update.message.document.mime_type and update.message.document.mime_type.startswith('video/'):
        file_id = update.message.document.file_id
        file_type = 'document'
        logger.info(f"Document video received: {file_id}")
    else:
        await update.message.reply_text("❌ Kirim file video!")
        return
    
    caption = update.message.caption
    if not caption or caption.strip() == "":
        caption = "Tanpa Judul"
    
    # Cek apakah judul sudah terdaftar
    if caption != "Tanpa Judul":
        existing_video = get_video_by_caption(caption)
        if existing_video:
            video_link = generate_video_link(existing_video['code'])
            await update.message.reply_text(
                f"⚠️ *Judul sudah terdaftar!*\n\n"
                f"Judul: `{caption}`\n"
                f"Status: Sudah ada di database\n\n"
                f"🔗 Link: {video_link}",
                parse_mode=ParseMode.MARKDOWN
            )
            return
            
    video_code = generate_video_code()
    while True:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM videos WHERE code = ?", (video_code,))
            if not cursor.fetchone():
                break
        video_code = generate_video_code()
    
    uploader_name = get_user_display_name(user)
    waktu_sekarang = datetime.now().strftime("%d-%m-%Y %H:%M")
    
    # Tentukan akses type (Otomatis VIP jika dari sumber grup)
    default_access = 'VIP' if is_from_source else 'FREE'
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO videos (
                code, file_id, caption, file_type, 
                uploaded_by, uploader_name, access_type, view_count
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        """, (video_code, file_id, caption, file_type, user.id, uploader_name, default_access))
        video_id = cursor.lastrowid
        conn.commit()
        
        backup_caption = format_backup_caption(
            video_code=video_code,
            caption=caption,
            uploader_name=uploader_name,
            waktu=waktu_sekarang,
            access_type="free / vip sesuai setingan setelah upload"
        )
        
        try:
            backup_msg = await context.bot.send_document(
                chat_id=BACKUP_CHANNEL_ID,
                document=file_id,
                caption=backup_caption
            )
            
            cursor.execute("UPDATE videos SET backup_message_id = ? WHERE id = ?", (backup_msg.message_id, video_id))
            logger.info(f"Document backed up to channel: {backup_msg.message_id}")
        except Exception as e:
            logger.error(f"Gagal kirim ke backup channel: {e}")
        
        try:
            log_caption = backup_caption + "\n\n🆔 ID Video: " + str(video_id)
            log_keyboard = create_video_keyboard(video_id, "FREE")
            
            log_msg = await context.bot.send_document(
                chat_id=LOG_CHANNEL_ID,
                document=file_id,
                caption=log_caption,
                reply_markup=log_keyboard
            )
            
            cursor.execute("UPDATE videos SET log_message_id = ? WHERE id = ?", (log_msg.message_id, video_id))
            conn.commit()
            logger.info(f"Document logged to channel: {log_msg.message_id}")
        except Exception as e:
            logger.error(f"Gagal kirim ke log channel: {e}")
    
    video_link = generate_video_link(video_code)
    
    await update.message.reply_text(
        f"✅ Video Berhasil Diupload!\n\n"
        f"🔗 Link Video:\n"
        f"{video_link}\n\n"
        f"📝 Judul: {caption}\n"
        f"📌 Kode: {video_code}\n"
        f"👤 Uploader: {uploader_name}\n"
        f"⏰ Waktu: {waktu_sekarang}\n\n"
        f"Pilih tipe akses untuk video ini:",
        reply_markup=InlineKeyboardMarkup([
            [
                InlineKeyboardButton("🔓 FREE", callback_data=f"video_set_free_{video_id}"),
                InlineKeyboardButton("💎 VIP", callback_data=f"video_set_vip_{video_id}")
            ]
        ])
    )

async def handle_channel_post(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk membaca video dari channel/grup sumber terdaftar"""
    post = update.channel_post
    if not post:
        return
        
    chat_id = post.chat.id
    
    # Cek apakah dari grup/channel sumber terdaftar
    is_from_source = False
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM source_groups WHERE chat_id = ? AND is_active = 1", (chat_id,))
        if cursor.fetchone():
            is_from_source = True
            
    if not is_from_source:
        # Pengecekan legacy (hardcoded channel)
        TARGET_CHANNEL_ID = -1003805656274
        if chat_id != TARGET_CHANNEL_ID:
            return
        
    if post.video:
        file_id = post.video.file_id
        file_type = 'video'
    elif post.document and post.document.mime_type and post.document.mime_type.startswith('video/'):
        file_id = post.document.file_id
        file_type = 'document'
    else:
        return

    caption = post.caption
    if not caption or caption.strip() == "":
        caption = "Tanpa Judul"
        
    # Cek apakah judul sudah terdaftar (Auto Channel)
    if caption != "Tanpa Judul":
        existing_video = get_video_by_caption(caption)
        if existing_video:
            logger.info(f"Auto Channel: Judul '{caption}' sudah terdaftar, melewati...")
            return
            
    video_code = generate_video_code()
    while True:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT id FROM videos WHERE code = ?", (video_code,))
            if not cursor.fetchone():
                break
        video_code = generate_video_code()

    uploader_name = "Auto Channel"
    waktu_sekarang = datetime.now().strftime("%d-%m-%Y %H:%M")
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO videos (
                code, file_id, caption, file_type, 
                uploaded_by, uploader_name, access_type, view_count
            )
            VALUES (?, ?, ?, ?, ?, ?, 'VIP', 0)
        """, (video_code, file_id, caption, file_type, 0, uploader_name))
        video_id = cursor.lastrowid
        conn.commit()
        
        backup_caption = format_backup_caption(
            video_code=video_code,
            caption=caption,
            uploader_name=uploader_name,
            waktu=waktu_sekarang,
            access_type="VIP (Auto Channel)"
        )
        
        try:
            if file_type == 'video':
                backup_msg = await context.bot.send_video(
                    chat_id=BACKUP_CHANNEL_ID,
                    video=file_id,
                    caption=backup_caption
                )
            else:
                backup_msg = await context.bot.send_document(
                    chat_id=BACKUP_CHANNEL_ID,
                    document=file_id,
                    caption=backup_caption
                )
            
            cursor.execute("UPDATE videos SET backup_message_id = ? WHERE id = ?", (backup_msg.message_id, video_id))
        except Exception as e:
            logger.error(f"Gagal kirim ke backup channel: {e}")
            
        try:
            log_caption = backup_caption + "\n\n🆔 ID Video: " + str(video_id)
            log_keyboard = create_video_keyboard(video_id, "VIP")
            
            if file_type == 'video':
                log_msg = await context.bot.send_video(
                    chat_id=LOG_CHANNEL_ID,
                    video=file_id,
                    caption=log_caption,
                    reply_markup=log_keyboard
                )
            else:
                log_msg = await context.bot.send_document(
                    chat_id=LOG_CHANNEL_ID,
                    document=file_id,
                    caption=log_caption,
                    reply_markup=log_keyboard
                )
            
            cursor.execute("UPDATE videos SET log_message_id = ? WHERE id = ?", (log_msg.message_id, video_id))
            conn.commit()
        except:
            pass

    video_link = generate_video_link(video_code)
    
    try:
        new_caption = f"{caption}\n\n🔗 *Link Video VIP:*\n{video_link}"
        keyboard = [[InlineKeyboardButton("🎬 Tonton Video (VIP)", url=video_link)]]
        
        await context.bot.edit_message_caption(
            chat_id=post.chat.id,
            message_id=post.message_id,
            caption=new_caption,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
        logger.info(f"Video dari channel otomatis diubah jadi VIP: {video_code}")
    except Exception as e:
        logger.error(f"Gagal edit post channel: {e}")

# ===================== PAYMENT HANDLERS =====================
async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk upload bukti pembayaran QRIS"""
    user = update.effective_user
    
    if 'buy_days' not in context.user_data or 'buy_type' not in context.user_data:
        await update.message.reply_text("❌ Silakan pilih paket VIP terlebih dahulu!")
        return
    
    days = context.user_data['buy_days']
    amount = context.user_data['buy_amount']
    payment_type = context.user_data['buy_type']
    file_id = update.message.photo[-1].file_id
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO payments (user_id, amount, days, payment_type, proof_file_id, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING')
        """, (user.id, amount, days, payment_type, file_id))
        payment_id = cursor.lastrowid
        conn.commit()
        
        # [FIREBASE] Sync pembayaran baru
        firebase_sync.sync_payment_create(
            payment_id=payment_id, user_id=user.id,
            amount=amount, days=days,
            payment_type=payment_type, proof_file_id=file_id
        )
    
    keyboard = [
        [
            InlineKeyboardButton("✅ TERIMA", callback_data=f"payment_approve_{payment_id}"),
            InlineKeyboardButton("❌ TOLAK", callback_data=f"payment_reject_{payment_id}")
        ]
    ]
    
    for admin_id in ADMIN_IDS:
        try:
            caption = (
                f"💳 *PEMBAYARAN BARU #{payment_id}*\n"
                f"━━━━━━━━━━━━━━━━━━━\n"
                f"👤 *User:* [{user.first_name}](tg://user?id={user.id})\n"
                f"📱 *Username:* @{user.username or 'None'}\n"
                f"🆔 *ID:* `{user.id}`\n"
                f"📦 *Tipe:* {payment_type}\n"
                f"📅 *Paket:* {days} Hari\n"
                f"💰 *Total:* Rp {amount:,}\n"
                f"━━━━━━━━━━━━━━━━━━━\n"
                f"⚠️ *Perlu Konfirmasi Admin*"
            )
            
            await context.bot.send_photo(
                chat_id=admin_id,
                photo=file_id,
                caption=caption,
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
        except Exception as e:
            logger.error(f"Error sending to admin {admin_id}: {e}")
    
    context.user_data.clear()
    
    await update.message.reply_text(
        "✅ Bukti pembayaran QRIS telah dikirim!\n\n"
        "Admin akan segera memproses pembayaran Anda.\n"
        "Gunakan perintah /status untuk mengecek status."
    )

# ===================== BROADCAST HANDLERS =====================
async def broadcast_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /broadcast - Memulai proses broadcast"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Anda tidak memiliki izin untuk menggunakan perintah ini!")
        return
    
    context.user_data['broadcast_mode'] = 'waiting_content'
    context.user_data['broadcast_data'] = {}
    
    await update.message.reply_text(
        "📢 *MODE BROADCAST*\n\n"
        "Silakan kirim pesan yang ingin di-broadcast.\n\n"
        "✅ Mendukung:\n"
        "• Teks biasa\n"
        "• Gambar dengan caption\n"
        "• Video dengan caption\n"
        "• Dokumen dengan caption\n\n"
        "Ketik /cancel untuk membatalkan.",
        parse_mode=ParseMode.MARKDOWN
    )

async def broadcast_status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /broadcast_status - Melihat status broadcast"""
    user = update.effective_user
    
    if not is_admin(user.id):
        await update.message.reply_text("❌ Anda tidak memiliki izin untuk menggunakan perintah ini!")
        return
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM broadcasts 
            WHERE admin_id = ? 
            ORDER BY created_at DESC 
            LIMIT 10
        """, (user.id,))
        broadcasts = cursor.fetchall()
    
    if not broadcasts:
        await update.message.reply_text("📊 Belum ada riwayat broadcast.")
        return
    
    text = "📊 *RIWAYAT BROADCAST (10 Terakhir)*\n\n"
    
    for b in broadcasts:
        status_emoji = "✅" if b['status'] == 'COMPLETED' else "⏳" if b['status'] == 'PROCESSING' else "❌"
        text += f"{status_emoji} *ID: #{b['id']}*\n"
        text += f"Tipe: {b['message_type']}\n"
        text += f"Tgl: {b['created_at'][:16]}\n"
        text += f"Terkirim: {b['success_count']}/{b['total_recipients']}\n"
        text += f"Gagal: {b['fail_count']}\n"
        text += "─" * 30 + "\n"
    
    await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)

async def handle_broadcast_content(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk menerima konten broadcast"""
    user = update.effective_user
    
    if not is_admin(user.id) or context.user_data.get('broadcast_mode') != 'waiting_content':
        return
    
    broadcast_data = context.user_data.get('broadcast_data', {})
    
    if update.message.text:
        broadcast_data['type'] = 'text'
        broadcast_data['content'] = update.message.text
    elif update.message.photo:
        broadcast_data['type'] = 'photo'
        broadcast_data['file_id'] = update.message.photo[-1].file_id
        broadcast_data['caption'] = update.message.caption or ''
    elif update.message.video:
        broadcast_data['type'] = 'video'
        broadcast_data['file_id'] = update.message.video.file_id
        broadcast_data['caption'] = update.message.caption or ''
    elif update.message.document:
        broadcast_data['type'] = 'document'
        broadcast_data['file_id'] = update.message.document.file_id
        broadcast_data['caption'] = update.message.caption or ''
    else:
        await update.message.reply_text("❌ Tipe pesan tidak didukung untuk broadcast!")
        return
    
    context.user_data['broadcast_data'] = broadcast_data
    context.user_data['broadcast_mode'] = 'waiting_confirm'
    
    preview_text = "📋 *PREVIEW BROADCAST*\n\n"
    preview_text += f"Tipe: {broadcast_data['type'].upper()}\n"
    
    if broadcast_data['type'] == 'text':
        preview_text += f"\nKonten:\n{broadcast_data['content'][:500]}"
    else:
        preview_text += f"\nCaption:\n{broadcast_data.get('caption', '')[:500]}"
    
    preview_text += "\n\nApakah Anda yakin ingin mengirim broadcast ini ke SEMUA user?"
    
    keyboard = [
        [
            InlineKeyboardButton("✅ Ya, Kirim", callback_data="broadcast_confirm"),
            InlineKeyboardButton("❌ Batal", callback_data="broadcast_cancel")
        ]
    ]
    
    await update.message.reply_text(
        preview_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode=ParseMode.MARKDOWN
    )

async def broadcast_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk callback broadcast"""
    query = update.callback_query
    await query.answer()
    
    user = update.effective_user
    
    if not is_admin(user.id):
        await query.edit_message_text("❌ Anda bukan admin!")
        return
    
    data = query.data
    
    if data == "broadcast_confirm":
        broadcast_data = context.user_data.get('broadcast_data')
        
        if not broadcast_data:
            await query.edit_message_text("❌ Data broadcast tidak ditemukan!")
            context.user_data.pop('broadcast_mode', None)
            context.user_data.pop('broadcast_data', None)
            return
        
        await query.edit_message_text("⏳ Memproses broadcast... Mohon tunggu.")
        
        # Dapatkan semua user
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT user_id FROM users")
            all_users = cursor.fetchall()
            
            # Buat record broadcast
            cursor.execute("""
                INSERT INTO broadcasts (
                    admin_id, message_type, content, file_id, caption, total_recipients
                ) VALUES (?, ?, ?, ?, ?, ?)
            """, (
                user.id,
                broadcast_data['type'],
                broadcast_data.get('content'),
                broadcast_data.get('file_id'),
                broadcast_data.get('caption'),
                len(all_users)
            ))
            broadcast_id = cursor.lastrowid
            
            # Masukkan ke queue
            for u in all_users:
                cursor.execute("""
                    INSERT INTO broadcast_queue (broadcast_id, user_id)
                    VALUES (?, ?)
                """, (broadcast_id, u['user_id']))
            
            conn.commit()
        
        context.user_data.pop('broadcast_mode', None)
        context.user_data.pop('broadcast_data', None)
        
        # Mulai proses broadcast di background
        asyncio.create_task(process_broadcast(context.application, broadcast_id))
        
        await query.edit_message_text(
            f"✅ Broadcast #{broadcast_id} telah dimulai!\n"
            f"Total penerima: {len(all_users)} user\n\n"
            f"Gunakan /broadcast_status untuk melihat progress."
        )
    
    elif data == "broadcast_cancel":
        context.user_data.pop('broadcast_mode', None)
        context.user_data.pop('broadcast_data', None)
        await query.edit_message_text("✅ Broadcast dibatalkan.")

async def process_broadcast(application: Application, broadcast_id: int):
    """Proses broadcast di background"""
    logger.info(f"Starting broadcast #{broadcast_id}")
    
    while True:
        with get_db() as conn:
            cursor = conn.cursor()
            
            # Ambil 10 pesan yang belum terkirim
            cursor.execute("""
                SELECT q.id, q.user_id, b.* 
                FROM broadcast_queue q
                JOIN broadcasts b ON q.broadcast_id = b.id
                WHERE q.broadcast_id = ? AND q.status = 'PENDING'
                LIMIT 10
            """, (broadcast_id,))
            queue_items = cursor.fetchall()
            
            if not queue_items:
                # Update status broadcast selesai
                cursor.execute("""
                    UPDATE broadcasts 
                    SET status = 'COMPLETED', completed_at = ? 
                    WHERE id = ?
                """, (datetime.now().isoformat(), broadcast_id))
                conn.commit()
                logger.info(f"Broadcast #{broadcast_id} completed")
                break
            
            success_count = 0
            fail_count = 0
            
            is_protected = (get_setting('protect_content') == 'ON')
            
            for item in queue_items:
                try:
                    if item['message_type'] == 'text':
                        await application.bot.send_message(
                            chat_id=item['user_id'],
                            text=item['content'],
                            protect_content=is_protected
                        )
                    elif item['message_type'] == 'photo':
                        await application.bot.send_photo(
                            chat_id=item['user_id'],
                            photo=item['file_id'],
                            caption=item['caption'],
                            protect_content=is_protected
                        )
                    elif item['message_type'] == 'video':
                        await application.bot.send_video(
                            chat_id=item['user_id'],
                            video=item['file_id'],
                            caption=item['caption'],
                            protect_content=is_protected
                        )
                    elif item['message_type'] == 'document':
                        await application.bot.send_document(
                            chat_id=item['user_id'],
                            document=item['file_id'],
                            caption=item['caption'],
                            protect_content=is_protected
                        )
                    
                    cursor.execute("""
                        UPDATE broadcast_queue 
                        SET status = 'SENT', sent_at = ? 
                        WHERE id = ?
                    """, (datetime.now().isoformat(), item['id']))
                    success_count += 1
                    
                except Exception as e:
                    logger.error(f"Broadcast error to user {item['user_id']}: {e}")
                    cursor.execute("""
                        UPDATE broadcast_queue 
                        SET status = 'FAILED', error_message = ? 
                        WHERE id = ?
                    """, (str(e)[:200], item['id']))
                    fail_count += 1
                
                await asyncio.sleep(0.05)  # Rate limiting
            
            # Update broadcast stats
            cursor.execute("""
                UPDATE broadcasts 
                SET success_count = success_count + ?,
                    fail_count = fail_count + ?
                WHERE id = ?
            """, (success_count, fail_count, broadcast_id))
            conn.commit()
        
        await asyncio.sleep(1)  # Delay antar batch

async def show_admin_panel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fungsi helper untuk menampilkan Panel Admin"""
    query = update.callback_query
    user = update.effective_user
    
    if not is_admin(user.id):
        await query.answer("Anda bukan admin!")
        return

    with get_db() as conn:
        cursor = conn.cursor()
        # Statistik Dasar
        cursor.execute("SELECT COUNT(*) as total FROM videos")
        total_videos = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as total FROM users")
        total_users = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as total FROM source_groups")
        total_sources = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as total FROM payments WHERE status = 'PENDING'")
        total_pending = cursor.fetchone()['total']
        
        # Statistik VIP
        cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_until > datetime('now')")
        active_vip_regular = cursor.fetchone()['total']
        cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_limited_until > datetime('now')")
        active_vip_limited = cursor.fetchone()['total']
        
        # Broadcast
        cursor.execute("SELECT COUNT(*) as total FROM broadcasts WHERE status = 'PROCESSING'")
        processing_broadcast = cursor.fetchone()['total']
        
    is_protected = (get_setting('protect_content') == 'ON')
        
    text = (
        "⚙️ <b>PANEL ADMIN</b>\n\n"
        f"📊 <b>Statistik:</b>\n"
        f"• 🎬 Total Video: <b>{total_videos}</b>\n"
        f"• 👤 Total User: <b>{total_users}</b>\n"
        f"• 💎 VIP Regular: <b>{active_vip_regular}</b>\n"
        f"• 🔰 VIP Limited: <b>{active_vip_limited}</b>\n\n"
        f"💳 <b>Transaksi:</b>\n"
        f"• 💰 Pending: <b>{total_pending}</b>\n"
        f"• 📢 Broadcast Jalan: <b>{processing_broadcast}</b>\n\n"
        f"📡 Grup Sumber: <b>{total_sources}</b>\n"
        f"🛡️ Proteksi Konten: <b>{'ON' if is_protected else 'OFF'}</b>\n\n"
        "Silakan pilih menu di bawah ini:"
    )
    
    keyboard = [
        [
            InlineKeyboardButton("👥 CEK USER", callback_data="admin_check_user"),
            InlineKeyboardButton("📊 STATISTIK", callback_data="admin_stats")
        ],
        [
            InlineKeyboardButton("💰 BAYAR PENDING", callback_data="admin_pending_payments"),
            InlineKeyboardButton("🎟️ KODE REDEEM", callback_data="admin_redeem_menu")
        ],
        [
            InlineKeyboardButton("🔥 STATUS DB", callback_data="admin_db_status"),
            InlineKeyboardButton("📡 GRUP SUMBER", callback_data="admin_source_menu")
        ],
        [
            InlineKeyboardButton("➕ TAMBAH VIP", callback_data="admin_add_vip"),
            InlineKeyboardButton("➖ HAPUS VIP", callback_data="admin_remove_vip")
        ],
        [
            InlineKeyboardButton("💎 LIST MEMBER VIP", callback_data="admin_list_vip")
        ],
        [
            InlineKeyboardButton("📢 BROADCAST", callback_data="admin_broadcast_menu"),
            InlineKeyboardButton("📋 RIWAYAT BC", callback_data="admin_broadcast_history")
        ],
        [
            InlineKeyboardButton("🗑️ HAPUS VIDEO", callback_data="admin_delete_video"),
            InlineKeyboardButton("🛡️ PRIVASI: " + ("ON" if is_protected else "OFF"), callback_data="admin_toggle_privacy")
        ],
        [
            InlineKeyboardButton("🔄 UPDATE BOT", callback_data="admin_update_bot"),
            InlineKeyboardButton("🔙 TUTUP PANEL", callback_data="back_main")
        ]
    ]
    await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

async def show_source_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fungsi helper untuk menampilkan Menu Grup Sumber"""
    query = update.callback_query
    user = update.effective_user
    
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM source_groups")
        sources = cursor.fetchall()
        
    source_list = ""
    if sources:
        for s in sources:
            status_admin = "✅ Active" if s['is_active'] else "❌ Inactive"
            topic_info = f" [Topik: {s['thread_id']}]" if s['thread_id'] else ""
            source_list += f"📍 <b>{s['title'] or 'Grup'}</b>{topic_info}\n   └ ID: <code>{s['chat_id']}</code> | {status_admin}\n"
    else:
        source_list = "<i>Belum ada grup sumber terdaftar.</i>\n"
        
    text = (
        "📡 <b>MANAJEMEN GRUP SUMBER</b>\n\n"
        "Bot akan membaca video otomatis dari grup/topik di bawah ini:\n\n"
        f"{source_list}\n"
        "ℹ️ Gunakan /listgroup untuk daftar lebih detail."
    )
    keyboard = [
        [
            InlineKeyboardButton("➕ Tambah Grup", callback_data="admin_source_add"),
            InlineKeyboardButton("🗑️ Hapus Grup", callback_data="admin_source_del_menu")
        ],
        [InlineKeyboardButton("🔙 Kembali ke Panel", callback_data="admin_panel")]
    ]
    await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

# ===================== CALLBACK HANDLERS =====================
async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk semua callback"""
    query = update.callback_query
    await query.answer()
    
    user = update.effective_user
    data = query.data
    logger.info(f"Callback from user {user.id}: {data}")
    
    # ==================== NO ACTION ====================
    if data == "no_action":
        await query.answer("Informasi", show_alert=False)
        return
    
    # ==================== VIDEO MANAGEMENT ====================
    if data.startswith('video_set_free_'):
        if not is_admin(user.id):
            await query.answer("❌ Hanya admin!", show_alert=True)
            return
        
        video_id = int(data.split('_')[3])
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE videos SET access_type = 'FREE' WHERE id = ?", (video_id,))
            conn.commit()
            
            cursor.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
            video = cursor.fetchone()
            
            if video and video['log_message_id']:
                try:
                    waktu = datetime.fromisoformat(video['uploaded_at']).strftime("%d-%m-%Y %H:%M")
                    new_caption = format_backup_caption(
                        video_code=video['code'],
                        caption=video['caption'],
                        uploader_name=video['uploader_name'],
                        waktu=waktu,
                        access_type="FREE"
                    ) + f"\n\n🆔 ID Video: {video_id}"
                    
                    new_keyboard = create_video_keyboard(video_id, "FREE")
                    
                    await context.bot.edit_message_caption(
                        chat_id=LOG_CHANNEL_ID,
                        message_id=video['log_message_id'],
                        caption=new_caption,
                        reply_markup=new_keyboard
                    )
                except Exception as e:
                    logger.error(f"Error updating log message: {e}")
        
        await query.edit_message_text("✅ Video sekarang FREE untuk semua user!")
    
    elif data.startswith('video_set_vip_'):
        if not is_admin(user.id):
            await query.answer("❌ Hanya admin!", show_alert=True)
            return
        
        video_id = int(data.split('_')[3])
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE videos SET access_type = 'VIP' WHERE id = ?", (video_id,))
            conn.commit()
            
            cursor.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
            video = cursor.fetchone()
            
            if video and video['log_message_id']:
                try:
                    waktu = datetime.fromisoformat(video['uploaded_at']).strftime("%d-%m-%Y %H:%M")
                    new_caption = format_backup_caption(
                        video_code=video['code'],
                        caption=video['caption'],
                        uploader_name=video['uploader_name'],
                        waktu=waktu,
                        access_type="VIP"
                    ) + f"\n\n🆔 ID Video: {video_id}"
                    
                    new_keyboard = create_video_keyboard(video_id, "VIP")
                    
                    await context.bot.edit_message_caption(
                        chat_id=LOG_CHANNEL_ID,
                        message_id=video['log_message_id'],
                        caption=new_caption,
                        reply_markup=new_keyboard
                    )
                except Exception as e:
                    logger.error(f"Error updating log message: {e}")
        
        await query.edit_message_text("✅ Video sekarang khusus member VIP!")
    
    elif data.startswith('video_open_'):
        video_id = int(data.split('_')[2])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
            video = cursor.fetchone()
            
            if video:
                video_link = generate_video_link(video['code'])
                await query.edit_message_text(
                    f"🎬 *Link Video*\n\n"
                    f"🔗 {video_link}\n\n"
                    f"📌 Kode: `{video['code']}`\n"
                    f"📝 Judul: {video['caption']}\n"
                    f"🔓 Tipe: {video['access_type']}\n"
                    f"👁 Views: {video['view_count']}",
                    parse_mode=ParseMode.MARKDOWN
                )
            else:
                await query.answer("❌ Video tidak ditemukan!", show_alert=True)
    
    elif data.startswith('video_changetype_'):
        if not is_admin(user.id):
            await query.answer("❌ Hanya admin!", show_alert=True)
            return
        
        video_id = int(data.split('_')[2])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT access_type FROM videos WHERE id = ?", (video_id,))
            video = cursor.fetchone()
            
            if video:
                current_type = video['access_type']
                
                keyboard = [
                    [
                        InlineKeyboardButton("🔓 FREE", callback_data=f"video_set_free_{video_id}"),
                        InlineKeyboardButton("💎 VIP", callback_data=f"video_set_vip_{video_id}")
                    ],
                    [InlineKeyboardButton("🔙 Kembali", callback_data="no_action")]
                ]
                
                await query.edit_message_text(
                    f"🔒 *Ubah Tipe Video*\n\n"
                    f"ID Video: `{video_id}`\n"
                    f"Tipe Saat Ini: **{current_type}**\n\n"
                    f"Pilih tipe baru:",
                    parse_mode=ParseMode.MARKDOWN,
                    reply_markup=InlineKeyboardMarkup(keyboard)
                )
            else:
                await query.answer("❌ Video tidak ditemukan!", show_alert=True)
    
    elif data.startswith('video_delete_'):
        if not is_admin(user.id):
            await query.answer("❌ Hanya admin!", show_alert=True)
            return
        
        video_id = int(data.split('_')[2])
        
        keyboard = [
            [
                InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"video_delete_confirm_{video_id}"),
                InlineKeyboardButton("❌ Batal", callback_data="no_action")
            ]
        ]
        
        await query.edit_message_text(
            f"⚠️ *Konfirmasi Hapus Video*\n\n"
            f"Anda akan menghapus video ID: `{video_id}`\n\n"
            f"Yakin ingin melanjutkan?",
            parse_mode=ParseMode.MARKDOWN,
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    
    elif data.startswith('video_delete_confirm_'):
        if not is_admin(user.id):
            await query.answer("❌ Hanya admin!", show_alert=True)
            return
        
        video_id = int(data.split('_')[3])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM videos WHERE id = ?", (video_id,))
            video = cursor.fetchone()
            
            if video:
                cursor.execute("DELETE FROM videos WHERE id = ?", (video_id,))
                conn.commit()
                
                if video['log_message_id']:
                    try:
                        await context.bot.delete_message(
                            chat_id=LOG_CHANNEL_ID,
                            message_id=video['log_message_id']
                        )
                    except:
                        pass
                
                if video['backup_message_id']:
                    try:
                        await context.bot.delete_message(
                            chat_id=BACKUP_CHANNEL_ID,
                            message_id=video['backup_message_id']
                        )
                    except:
                        pass
                
                await query.edit_message_text(
                    f"✅ Video ID `{video_id}` berhasil dihapus!",
                    parse_mode=ParseMode.MARKDOWN
                )
            else:
                await query.answer("❌ Video tidak ditemukan!", show_alert=True)
    
    # ==================== PAYMENT APPROVAL ====================
    elif data.startswith('payment_approve_'):
        if not is_admin(user.id):
            await query.message.reply_text("❌ Anda bukan admin!")
            return
        
        payment_id = int(data.split('_')[2])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM payments WHERE id = ?", (payment_id,))
            payment = cursor.fetchone()
            
            if not payment:
                await safe_edit_message(query, "❌ Pembayaran tidak ditemukan!")
                return
            
            if payment['status'] != 'PENDING':
                await safe_edit_message(
                    query,
                    f"❌ Pembayaran #{payment_id} sudah diproses!\nStatus: {payment['status']}"
                )
                return
            
            now = datetime.now()
            
            if payment['payment_type'] == 'REGULAR':
                vip_until = now + timedelta(days=payment['days'])
                cursor.execute("""
                    UPDATE users SET vip_until = ? WHERE user_id = ?
                """, (vip_until.isoformat(), payment['user_id']))
                
                text = (
                    f"✅ PEMBAYARAN VIP REGULAR DITERIMA!\n\n"
                    f"Terima kasih! Pembayaran Anda telah dikonfirmasi.\n\n"
                    f"📦 Paket: {payment['days']} Hari VIP Regular\n"
                    f"💰 Total: Rp {payment['amount']:,}\n"
                    f"📅 Berlaku sampai: {vip_until.strftime('%d %B %Y %H:%M')}\n\n"
                    f"Selamat menikmati akses penuh ke semua video VIP! 🎉"
                )
            else:  # LIMITED
                limited_until = now + timedelta(days=payment['days'])
                
                # Tentukan jumlah views berdasarkan paket
                if payment['days'] == 1:
                    views = 2
                else:  # days == 3
                    views = 6
                
                cursor.execute("""
                    UPDATE users 
                    SET vip_limited_until = ?, 
                        vip_limited_views = 0,
                        vip_limited_total_views = ?
                    WHERE user_id = ?
                """, (limited_until.isoformat(), views, payment['user_id']))
                
                text = (
                    f"✅ PEMBAYARAN VIP LIMITED DITERIMA!\n\n"
                    f"Terima kasih! Pembayaran Anda telah dikonfirmasi.\n\n"
                    f"📦 Paket: {payment['days']} Hari VIP Limited\n"
                    f"💰 Total: Rp {payment['amount']:,}\n"
                    f"📅 Berlaku sampai: {limited_until.strftime('%d %B %Y %H:%M')}\n"
                    f"👁 Kuota: {views}x lihat video VIP\n\n"
                    f"Silakan nikmati video VIP! 🎉"
                )
            
            cursor.execute("""
                UPDATE payments 
                SET status = 'APPROVED', approved_by = ?, approved_at = ?
                WHERE id = ?
            """, (user.id, now.isoformat(), payment_id))
            conn.commit()
            
            # [FIREBASE] Sync pembayaran approved + update VIP user
            firebase_sync.sync_payment_approved(payment_id, approved_by=user.id)
            if payment['payment_type'] == 'REGULAR':
                firebase_sync.sync_user_vip_update(
                    payment['user_id'],
                    vip_until_iso=vip_until.isoformat()
                )
            else:
                firebase_sync.sync_user_vip_update(
                    payment['user_id'],
                    vip_until_iso=None,
                    vip_limited_until_iso=limited_until.isoformat(),
                    vip_limited_views=0,
                    vip_limited_total_views=views
                )
            
            try:
                await context.bot.send_message(
                    chat_id=payment['user_id'],
                    text=text
                )
            except:
                pass
        
        # Ambil info user untuk detail laporan
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT first_name, username FROM users WHERE user_id = ?", (payment['user_id'],))
            u_info = cursor.fetchone()
            
        await safe_edit_message(
            query,
            f"✅ <b>PEMBAYARAN DISETUJUI</b>\n\n"
            f"👤 User: {u_info['first_name']} (@{u_info['username'] or 'None'})\n"
            f"🆔 ID: <code>{payment['user_id']}</code>\n"
            f"💰 Nominal: Rp {payment['amount']:,}\n"
            f"📦 Paket: {payment['days']} Hari ({payment['payment_type']})\n"
            f"✅ Diproses oleh: {user.first_name}",
            reply_markup=InlineKeyboardMarkup([
                [InlineKeyboardButton("💬 CHAT USER", callback_data=f"admin_chat_user_{payment['user_id']}")]
            ]),
            parse_mode=ParseMode.HTML
        )
    
    elif data.startswith('payment_reject_'):
        if not is_admin(user.id):
            await query.message.reply_text("❌ Anda bukan admin!")
            return
        
        payment_id = int(data.split('_')[2])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM payments WHERE id = ?", (payment_id,))
            payment = cursor.fetchone()
            
            if not payment:
                await safe_edit_message(query, "❌ Pembayaran tidak ditemukan!")
                return
            
            if payment['status'] != 'PENDING':
                await safe_edit_message(
                    query,
                    f"❌ Pembayaran #{payment_id} sudah diproses!\nStatus: {payment['status']}"
                )
                return
        
        context.user_data['reject_payment_id'] = payment_id
        context.user_data['waiting_reject_reason'] = True
        
        keyboard = [[InlineKeyboardButton("🔙 Batal", callback_data="payment_reject_cancel")]]
        
        await safe_edit_message(
            query,
            f"❌ *TOLAK PEMBAYARAN #{payment_id}*\n\n"
            f"👤 User ID: `{payment['user_id']}`\n"
            f"💰 Nominal: Rp {payment['amount']:,}\n\n"
            f"Silakan kirim alasan penolakan sebagai *balasan pesan ini*.\n\n"
            f"Contoh: Bukti transfer tidak valid / Nominal kurang.",
            reply_markup=keyboard,
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "payment_reject_cancel":
        context.user_data.pop('reject_payment_id', None)
        context.user_data.pop('waiting_reject_reason', None)
        await query.edit_message_text("✅ Penolakan dibatalkan.")
    
    elif data.startswith("admin_chat_user_") and is_admin(user.id):
        target_id = int(data.split("_")[-1])
        context.user_data['waiting_admin_chat'] = target_id
        await query.message.reply_text(
            f"💬 <b>KIRIM PESAN KE USER</b>\n\n"
            f"ID User: <code>{target_id}</code>\n\n"
            f"Silakan ketik pesan yang ingin dikirim ke user ini.\n"
            f"Pesan akan dikirim atas nama Bot.",
            parse_mode=ParseMode.HTML
        )
        await query.answer()
    
    # ==================== VIP MENU ====================
    elif data == "vip_status":
        status = get_user_status(user.id)
        
        if status['vip_overall'] == 'REGULAR':
            keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="back_main")]]
            await safe_edit_message(
                query,
                f"💎 *Status VIP Regular*\n\n"
                f"✅ AKTIF\n"
                f"Berlaku sampai: {status['expiry_date']}\n"
                f"Sisa: {status['days_left']} hari {status['hours_left']} jam",
                reply_markup=InlineKeyboardMarkup(keyboard),
                parse_mode=ParseMode.MARKDOWN
            )
        elif status['vip_overall'] == 'LIMITED':
            total_views = status.get('vip_limited_total_views', 2)
            views_left = status.get('limited_views_left', 0)
            keyboard = [
                [InlineKeyboardButton("💎 Upgrade ke Regular", callback_data="buy_vip_regular")],
                [InlineKeyboardButton("🔙 Kembali", callback_data="back_main")]
            ]
            await safe_edit_message(
                query,
                f"🔰 *Status VIP Limited*\n\n"
                f"✅ AKTIF\n"
                f"Berlaku sampai: {status['limited_expiry_date']}\n"
                f"Sisa kuota: {views_left} dari {total_views} kali\n\n"
                f"Upgrade ke VIP Regular untuk akses tanpa batas!",
                reply_markup=InlineKeyboardMarkup(keyboard),
                parse_mode=ParseMode.MARKDOWN
            )
        else:
            pending_text = ""
            if status['pending_payments'] > 0:
                pending_text = f"\n⏳ Pembayaran pending: {status['pending_payments']}"
            
            keyboard = [
                [InlineKeyboardButton("💰 Beli VIP", callback_data="buy_vip")],
                [InlineKeyboardButton("🔙 Kembali", callback_data="back_main")]
            ]
            await safe_edit_message(
                query,
                f"❌ Anda belum VIP\n\n"
                f"💎 VIP Regular: Akses penuh semua video\n"
                f"🔰 VIP Limited: 1 hari (2x lihat), 3 hari (6x lihat){pending_text}",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
    
    elif data == "buy_vip":
        keyboard = [
            [InlineKeyboardButton("🎁 REDEEM KODE VIP", callback_data="user_redeem_start")],
            [InlineKeyboardButton("🔰 VIP LIMITED (COBA)", callback_data="buy_vip_limited_menu")],
            [InlineKeyboardButton("💎 VIP REGULAR (FULL)", callback_data="buy_vip_regular_menu")],
            [InlineKeyboardButton("🔙 KEMBALI", callback_data="vip_status")]
        ]
        
        await safe_edit_message(
            query,
            "💎 *PILIH LAYANAN VIP*\n\n"
            "🎁 *Punya Kode Redeem?*\n"
            "Klik tombol Masukkan Kode Redeem di bawah.\n\n"
            "🔰 *VIP Limited* - Untuk mencoba\n"
            "• 1 Hari: Rp 1.000 (2x lihat)\n\n"
            "💎 *VIP Regular* - Full Akses\n"
            "• Harga: Rp 1.000/hari\n"
            "• Akses tanpa batas",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )

    elif data == "user_redeem_start":
        context.user_data['waiting_redeem'] = True
        keyboard = [[InlineKeyboardButton("🔙 Batal", callback_data="buy_vip")]]
        await safe_edit_message(
            query,
            "🎁 *REDEEM KODE VIP*\n\n"
            "Silakan ketik atau tempel (paste) kode redeem Anda di bawah ini.\n\n"
            "Contoh: `VIP-ABCDE123`",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "buy_vip_limited_menu":
        keyboard = [
            [
                InlineKeyboardButton("1 Hari - Rp 1.000 (2x lihat)", callback_data="buy_limited_1_1000_2"),
                InlineKeyboardButton("3 Hari - Rp 3.000 (6x lihat)", callback_data="buy_limited_3_3000_6")
            ],
            [InlineKeyboardButton("🔙 Kembali", callback_data="buy_vip")]
        ]
        
        await safe_edit_message(
            query,
            "🔰 *VIP LIMITED*\n\n"
            "Paket untuk mencoba:\n"
            "• 1 Hari - Rp 1.000 (2x lihat)\n"
            "• 3 Hari - Rp 3.000 (6x lihat)\n\n"
            "Pilih paket:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "buy_vip_regular_menu":
        keyboard = []
        for days in [7, 14, 30, 60, 90]:
            price = days * PRICE_PER_DAY
            keyboard.append([InlineKeyboardButton(
                f"{days} Hari - Rp {price:,}",
                callback_data=f"buy_regular_{days}_{price}"
            )])
        keyboard.append([InlineKeyboardButton("🔙 Kembali", callback_data="buy_vip")])
        
        await safe_edit_message(
            query,
            "💎 *VIP REGULAR*\n\n"
            f"Harga: Rp {PRICE_PER_DAY:,}/hari\n"
            "Akses penuh semua video VIP\n\n"
            "Pilih durasi:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data.startswith('buy_limited_'):
        parts = data.split('_')
        days = int(parts[2])
        amount = int(parts[3])
        views = int(parts[4])  # Ambil jumlah views dari callback
        
        context.user_data['buy_days'] = days
        context.user_data['buy_amount'] = amount
        context.user_data['buy_type'] = 'LIMITED'
        context.user_data['buy_views'] = views  # Simpan jumlah views
        
        await query.message.reply_text(
            f"⏳ *MEMPERSIAPKAN PEMBAYARAN...*\n\n"
            f"Paket: VIP Limited {days} Hari ({views}x lihat)\n"
            f"Total: Rp {amount:,}",
            parse_mode=ParseMode.MARKDOWN
        )
        
        keyboard = [
            [InlineKeyboardButton("📤 Upload Bukti QRIS", callback_data="upload_proof")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="buy_vip_limited_menu")]
        ]
        
        try:
            await context.bot.send_photo(
                chat_id=user.id,
                photo=QRIS_IMAGE_URL,
                caption=(
                    f"💳 *PEMBAYARAN VIP LIMITED*\n\n"
                    f"📦 Paket: {days} Hari ({views}x lihat)\n"
                    f"💰 Total: Rp {amount:,}\n\n"
                    f"📌 *Cara Pembayaran:*\n"
                    f"1️⃣ Scan QRIS\n"
                    f"2️⃣ Transfer sesuai total\n"
                    f"3️⃣ Screenshot bukti\n"
                    f"4️⃣ Klik *Upload Bukti QRIS*\n\n"
                    f"⏳ Maksimal 1x24 jam"
                ),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            
            try:
                await query.message.delete()
            except:
                pass
        except Exception as e:
            logger.error(f"Error sending QRIS: {e}")
            await context.bot.send_message(
                chat_id=user.id,
                text=(
                    f"💳 *PEMBAYARAN VIP LIMITED*\n\n"
                    f"📦 Paket: {days} Hari ({views}x lihat)\n"
                    f"💰 Total: Rp {amount:,}\n\n"
                    f"📌 *QRIS:*\n{QRIS_IMAGE_URL}\n\n"
                    f"Klik *Upload Bukti QRIS* setelah transfer"
                ),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            
            try:
                await query.message.delete()
            except:
                pass
    
    elif data.startswith('buy_regular_'):
        parts = data.split('_')
        days = int(parts[2])
        amount = int(parts[3])
        
        context.user_data['buy_days'] = days
        context.user_data['buy_amount'] = amount
        context.user_data['buy_type'] = 'REGULAR'
        
        await query.message.reply_text(
            f"⏳ *MEMPERSIAPKAN PEMBAYARAN...*\n\n"
            f"Paket: VIP Regular {days} Hari\n"
            f"Total: Rp {amount:,}",
            parse_mode=ParseMode.MARKDOWN
        )
        
        keyboard = [
            [InlineKeyboardButton("📤 Upload Bukti QRIS", callback_data="upload_proof")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="buy_vip_regular_menu")]
        ]
        
        try:
            await context.bot.send_photo(
                chat_id=user.id,
                photo=QRIS_IMAGE_URL,
                caption=(
                    f"💳 *PEMBAYARAN VIP REGULAR*\n\n"
                    f"📦 Paket: {days} Hari (Full Akses)\n"
                    f"💰 Total: Rp {amount:,}\n\n"
                    f"📌 *Cara Pembayaran:*\n"
                    f"1️⃣ Scan QRIS\n"
                    f"2️⃣ Transfer sesuai total\n"
                    f"3️⃣ Screenshot bukti\n"
                    f"4️⃣ Klik *Upload Bukti QRIS*\n\n"
                    f"⏳ Maksimal 1x24 jam"
                ),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            
            try:
                await query.message.delete()
            except:
                pass
        except Exception as e:
            logger.error(f"Error sending QRIS: {e}")
            await context.bot.send_message(
                chat_id=user.id,
                text=(
                    f"💳 *PEMBAYARAN VIP REGULAR*\n\n"
                    f"📦 Paket: {days} Hari (Full Akses)\n"
                    f"💰 Total: Rp {amount:,}\n\n"
                    f"📌 *QRIS:*\n{QRIS_IMAGE_URL}\n\n"
                    f"Klik *Upload Bukti QRIS* setelah transfer"
                ),
                parse_mode=ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            
            try:
                await query.message.delete()
            except:
                pass
    
    elif data == "upload_proof":
        if query.message.text:
            await query.edit_message_text(
                "📤 *Upload Bukti Pembayaran QRIS*\n\n"
                "Silakan kirim screenshot bukti pembayaran QRIS.\n"
                "Format: Gambar (JPG/PNG)\n\n"
                "Pastikan screenshot jelas menunjukkan:\n"
                "✅ Nominal transfer sesuai\n"
                "✅ Tanggal dan waktu transaksi\n"
                "✅ Nama merchant/penerima",
                parse_mode=ParseMode.MARKDOWN
            )
        else:
            await query.message.reply_text(
                "📤 *Upload Bukti Pembayaran QRIS*\n\n"
                "Silakan kirim screenshot bukti pembayaran QRIS.\n"
                "Format: Gambar (JPG/PNG)\n\n"
                "Pastikan screenshot jelas menunjukkan:\n"
                "✅ Nominal transfer sesuai\n"
                "✅ Tanggal dan waktu transaksi\n"
                "✅ Nama merchant/penerima",
                parse_mode=ParseMode.MARKDOWN
            )
            
            try:
                await query.message.delete()
            except:
                pass
    
    elif data == "admin_panel" and is_admin(user.id):
        await show_admin_panel(update, context)

    elif data == "admin_source_menu" and is_admin(user.id):
        await show_source_menu(update, context)

    elif data == "admin_source_add" and is_admin(user.id):
        context.user_data['admin_mode'] = 'waiting_source_link'
        text = (
            "➕ <b>TAMBAH GRUP SUMBER</b>\n\n"
            "Silakan kirimkan link grup atau link topik grup.\n\n"
            "Contoh:\n"
            "• <code>https://t.me/nama_grup</code>\n"
            "• <code>https://t.me/c/123456789/10</code> (Topic link)\n\n"
            "Ketik /cancel untuk membatalkan."
        )
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup([[InlineKeyboardButton("🔙 Batal", callback_data="admin_source_menu")]]), parse_mode=ParseMode.HTML)

    elif data == "admin_source_del_menu" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM source_groups")
            sources = cursor.fetchall()
        
        if not sources:
            await query.answer("Belum ada grup terdaftar.", show_alert=True)
            return
            
        keyboard = []
        for s in sources:
            # Tampilkan tombol untuk tiap grup dan topik
            topic_tag = f" [Topic: {s['thread_id']}]" if s['thread_id'] else ""
            label = f"📍 {s['title'] or s['chat_id']}{topic_tag}"
            keyboard.append([InlineKeyboardButton(label, callback_data=f"admin_source_del_ask_{s['id']}")])
        
        keyboard.append([InlineKeyboardButton("🔙 Kembali", callback_data="admin_source_menu")])
        
        await safe_edit_message(query, "🗑️ <b>PILIH GRUP/TOPIK UNTUK DIHAPUS</b>\n\nKlik pada grup atau topik spesifik yang ingin Anda hapus:", reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data.startswith("admin_source_del_ask_") and is_admin(user.id):
        source_id = int(data.split("_")[-1])
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT title, chat_id FROM source_groups WHERE id = ?", (source_id,))
            source = cursor.fetchone()
            
        if not source:
            await query.answer("Grup tidak ditemukan!")
            return
            
        text = (
            "⚠️ <b>KONFIRMASI HAPUS GRUP</b>\n\n"
            f"Apakah Anda yakin ingin menghapus grup ini?\n"
            f"📍 Judul: <b>{source['title']}</b>\n"
            f"🆔 ID: <code>{source['chat_id']}</code>\n\n"
            "Bot akan berhenti membaca video otomatis dari grup ini."
        )
        keyboard = [
            [
                InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"admin_source_del_final_{source_id}"),
                InlineKeyboardButton("❌ Batal", callback_data="admin_source_del_menu")
            ]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data.startswith("admin_source_del_final_") and is_admin(user.id):
        source_id = int(data.split("_")[-1])
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM source_groups WHERE id = ?", (source_id,))
            conn.commit()
        await query.answer("✅ Grup berhasil dihapus!")
        # Kembali ke menu manajemen grup
        await show_source_menu(update, context)

    elif data == "admin_delete_video" and is_admin(user.id):
        context.user_data['admin_mode'] = 'waiting_delete_video'
        text = (
            "🗑️ <b>HAPUS VIDEO</b>\n\n"
            "Silakan kirimkan <b>Kode Video</b> atau <b>Judul</b> video yang ingin dihapus.\n\n"
            "Contoh: <code>ABCD123</code>\n\n"
            "Bot akan mencari video tersebut dan meminta konfirmasi hapus."
        )
        keyboard = [[InlineKeyboardButton("🔙 Batal", callback_data="admin_panel")]]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data == "admin_update_bot" and is_admin(user.id):
        await safe_edit_message(query, "🔄 <b>Sedang menarik pembaruan dari GitHub...</b>", parse_mode=ParseMode.HTML)
        try:
            import subprocess
            process = subprocess.Popen(["git", "pull"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            stdout, stderr = process.communicate()
            
            if process.returncode == 0:
                if "Already up to date." in stdout:
                    keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
                    await safe_edit_message(query, "✅ <b>Bot sudah dalam versi terbaru.</b>", reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
                else:
                    await safe_edit_message(
                        query, 
                        f"✅ <b>Berhasil menarik pembaruan!</b>\n\n"
                        f"<code>{stdout}</code>\n\n"
                        f"🔄 <b>Merestart bot...</b>", 
                        parse_mode=ParseMode.HTML
                    )
                    os.execl(sys.executable, sys.executable, *sys.argv)
            else:
                keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
                await safe_edit_message(
                    query, 
                    f"❌ <b>Gagal menarik pembaruan:</b>\n\n"
                    f"<code>{stderr}</code>", 
                    reply_markup=InlineKeyboardMarkup(keyboard), 
                    parse_mode=ParseMode.HTML
                )
        except Exception as e:
            keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
            await safe_edit_message(query, f"❌ <b>Terjadi kesalahan:</b> {e}", reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data == "buy_vip_regular":
        keyboard = []
        for days in [7, 14, 30, 60, 90]:
            price = days * PRICE_PER_DAY
            keyboard.append([InlineKeyboardButton(
                f"{days} Hari - Rp {price:,}",
                callback_data=f"buy_regular_{days}_{price}"
            )])
        keyboard.append([InlineKeyboardButton("🔙 Kembali", callback_data="vip_status")])
        
        await safe_edit_message(
            query,
            "💎 *VIP REGULAR*\n\n"
            f"Harga: Rp {PRICE_PER_DAY:,}/hari\n"
            "Akses penuh semua video VIP\n\n"
            "Pilih durasi:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "admin_toggle_privacy" and is_admin(user.id):
        current = get_setting('protect_content')
        new_status = "OFF" if current == "ON" else "ON"
        set_setting('protect_content', new_status)
        await query.answer(f"🛡️ Proteksi Konten: {new_status}", show_alert=True)
        
        # Trigger refresh admin panel secara manual
        await show_admin_panel(update, context)
    
    elif data == "admin_add_vip" and is_admin(user.id):
        context.user_data["admin_mode"] = "waiting_add_vip_id"
        await safe_edit_message(
            query,
            "➕ <b>TAMBAH VIP MANUAL</b>\n\n"
            "Silakan kirimkan <b>User ID</b> yang ingin diberikan VIP.\n\n"
            "Atau ketik /cancel untuk batal.",
            parse_mode=ParseMode.HTML
        )
    
    elif data == "admin_remove_vip" and is_admin(user.id):
        context.user_data["admin_mode"] = "waiting_remove_vip_id"
        await safe_edit_message(
            query,
            "➖ <b>HAPUS VIP MANUAL</b>\n\n"
            "Silakan kirimkan <b>User ID</b> yang ingin dihapus status VIP-nya.\n\n"
            "Atau ketik /cancel untuk batal.",
            parse_mode=ParseMode.HTML
        )

    elif data == "admin_list_vip" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT user_id, first_name, username, vip_until, vip_limited_until, vip_type
                FROM users 
                WHERE vip_until > datetime('now') 
                   OR vip_limited_until > datetime('now')
                ORDER BY vip_until DESC, vip_limited_until DESC
                LIMIT 50
            """)
            vip_members = cursor.fetchall()
            
        if not vip_members:
            await query.answer("Belum ada member VIP aktif.", show_alert=True)
            return

        text = "💎 <b>DAFTAR MEMBER VIP AKTIF (50 Terbaru)</b>\n\n"
        for i, m in enumerate(vip_members, 1):
            name = m['first_name'] or "User"
            uname = f"(@{m['username']})" if m['username'] else ""
            
            v_type = m['vip_type'] or "REGULAR"
            if m['vip_until']:
                expiry = m['vip_until'][:10]
            else:
                expiry = m['vip_limited_until'][:10]
                
            text += f"{i}. <b>{name}</b> {uname}\n   └ ID: <code>{m['user_id']}</code> | {v_type} | s/d {expiry}\n"
            
        keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
    
    elif data == "admin_check_user" and is_admin(user.id):
        context.user_data["admin_mode"] = "waiting_user_id"
        
        await safe_edit_message(
            query,
            "👥 <b>CEK USER</b>\n\n"
            "Silakan kirim User ID yang ingin dicek.\n\n"
            "Contoh:\n"
            "<code>5888747846</code>\n\n"
            "Atau ketik /cancel untuk batal.",
            parse_mode=ParseMode.HTML
        )
    
    elif data == "admin_stats" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) as total FROM users")
            result = cursor.fetchone()
            total_users = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_until > datetime('now')")
            result = cursor.fetchone()
            active_vip_regular = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_limited_until > datetime('now')")
            result = cursor.fetchone()
            active_vip_limited = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM videos")
            result = cursor.fetchone()
            total_videos = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM videos WHERE access_type = 'VIP'")
            result = cursor.fetchone()
            vip_videos = result['total'] if result else 0
            
            cursor.execute("SELECT SUM(view_count) as total_views FROM videos")
            result = cursor.fetchone()
            total_views = result['total_views'] if result and result['total_views'] is not None else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM payments WHERE status = 'APPROVED'")
            result = cursor.fetchone()
            total_payments = result['total'] if result else 0
            
            cursor.execute("SELECT SUM(amount) as total_revenue FROM payments WHERE status = 'APPROVED'")
            result = cursor.fetchone()
            total_revenue = result['total_revenue'] if result and result['total_revenue'] is not None else 0
        
        keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
        
        await safe_edit_message(
            query,
            f"📊 <b>STATISTIK BOT</b>\n\n"
            f"👥 <b>User:</b>\n"
            f"• Total User: {total_users}\n"
            f"• VIP Regular Aktif: {active_vip_regular}\n"
            f"• VIP Limited Aktif: {active_vip_limited}\n\n"
            f"🎬 <b>Video:</b>\n"
            f"• Total Video: {total_videos}\n"
            f"• Video VIP: {vip_videos}\n"
            f"• Total Tayangan: {total_views:,}\n\n"
            f"💰 <b>Keuangan:</b>\n"
            f"• Total Transaksi: {total_payments}\n"
            f"• Total Pendapatan: Rp {total_revenue:,}",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    elif data == "admin_payments_pending" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT p.*, u.username, u.first_name 
                FROM payments p
                JOIN users u ON p.user_id = u.user_id
                WHERE p.status = 'PENDING'
                ORDER BY p.created_at DESC
            """)
            payments = cursor.fetchall()
        
        if not payments:
            keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
            await safe_edit_message(
                query,
                "✅ Tidak ada pembayaran pending.",
                reply_markup=InlineKeyboardMarkup(keyboard)
            )
            return
        
        text = "💰 *PEMBAYARAN PENDING*\n\n"
        keyboard = []
        
        for p in payments[:5]:  # Maksimal 5 per halaman
            type_icon = "💎" if p['payment_type'] == 'REGULAR' else "🔰"
            text += f"{type_icon} *ID: #{p['id']}*\n"
            text += f"User: {p['first_name']} (@{p['username']})\n"
            text += f"Tipe: {p['payment_type']} - {p['days']} Hari\n"
            text += f"Total: Rp {p['amount']:,}\n"
            text += f"Tgl: {p['created_at'][:16]}\n"
            text += "─" * 30 + "\n"
            
            keyboard.append([InlineKeyboardButton(
                f"Proses #{p['id']}",
                callback_data=f"payment_process_{p['id']}"
            )])
        
        keyboard.append([InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")])
        
        await safe_edit_message(
            query,
            text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data.startswith('payment_process_') and is_admin(user.id):
        payment_id = int(data.split('_')[2])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT p.*, u.username, u.first_name, u.user_id
                FROM payments p
                JOIN users u ON p.user_id = u.user_id
                WHERE p.id = ?
            """, (payment_id,))
            payment = cursor.fetchone()
            
            if payment:
                type_icon = "💎" if payment['payment_type'] == 'REGULAR' else "🔰"
                keyboard = [
                    [
                        InlineKeyboardButton("✅ TERIMA", callback_data=f"payment_approve_{payment_id}"),
                        InlineKeyboardButton("❌ TOLAK", callback_data=f"payment_reject_{payment_id}")
                    ],
                    [InlineKeyboardButton("🔙 Kembali", callback_data="admin_payments_pending")]
                ]
                
                await safe_edit_message(
                    query,
                    f"{type_icon} *DETAIL PEMBAYARAN #{payment_id}*\n\n"
                    f"👤 User: {payment['first_name']}\n"
                    f"📱 Username: @{payment['username']}\n"
                    f"🆔 User ID: {payment['user_id']}\n"
                    f"📦 Tipe: {payment['payment_type']}\n"
                    f"📆 Paket: {payment['days']} Hari\n"
                    f"💰 Total: Rp {payment['amount']:,}\n"
                    f"📅 Tanggal: {payment['created_at']}\n\n"
                    f"Pilih tindakan:",
                    reply_markup=InlineKeyboardMarkup(keyboard),
                    parse_mode=ParseMode.MARKDOWN
                )
    
    elif data == "admin_broadcast_menu" and is_admin(user.id):
        keyboard = [
            [InlineKeyboardButton("📢 Buat Broadcast Baru", callback_data="admin_broadcast_new")],
            [InlineKeyboardButton("📊 Status Broadcast", callback_data="admin_broadcast_status")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]
        ]
        
        await safe_edit_message(
            query,
            "📢 <b>MENU BROADCAST</b>\n\n"
            "Pilih menu:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    elif data == "admin_broadcast_new" and is_admin(user.id):
        context.user_data['broadcast_mode'] = 'waiting_content'
        context.user_data['broadcast_data'] = {}
        
        await safe_edit_message(
            query,
            "📢 *MODE BROADCAST*\n\n"
            "Silakan kirim pesan yang ingin di-broadcast.\n\n"
            "✅ Mendukung:\n"
            "• Teks biasa\n"
            "• Gambar dengan caption\n"
            "• Video dengan caption\n"
            "• Dokumen dengan caption\n\n"
            "Ketik /cancel untuk membatalkan.",
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "admin_broadcast_status" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM broadcasts 
                ORDER BY created_at DESC 
                LIMIT 5
            """)
            broadcasts = cursor.fetchall()
        
        if not broadcasts:
            await safe_edit_message(
                query,
                "📊 Belum ada riwayat broadcast.",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("🔙 Kembali", callback_data="admin_broadcast_menu")
                ]])
            )
            return
        
        text = "📊 *BROADCAST TERBARU*\n\n"
        
        for b in broadcasts:
            status_emoji = "✅" if b['status'] == 'COMPLETED' else "⏳" if b['status'] == 'PROCESSING' else "❌"
            text += f"{status_emoji} *ID: #{b['id']}*\n"
            text += f"Tipe: {b['message_type']}\n"
            text += f"Tgl: {b['created_at'][:16]}\n"
            text += f"Terkirim: {b['success_count']}/{b['total_recipients']}\n"
            text += f"Gagal: {b['fail_count']}\n"
            text += "─" * 30 + "\n"
        
        text += "\nGunakan /broadcast_status untuk detail lebih lengkap."
        
        keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_broadcast_menu")]]
        
        await safe_edit_message(
            query,
            text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "admin_broadcast_history" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM broadcasts 
                WHERE admin_id = ? 
                ORDER BY created_at DESC 
                LIMIT 10
            """, (user.id,))
            broadcasts = cursor.fetchall()
        
        if not broadcasts:
            await safe_edit_message(
                query,
                "📊 Belum ada riwayat broadcast.",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")
                ]])
            )
            return
        
        text = "📊 *RIWAYAT BROADCAST (10 Terakhir)*\n\n"
        
        for b in broadcasts:
            status_emoji = "✅" if b['status'] == 'COMPLETED' else "⏳" if b['status'] == 'PROCESSING' else "❌"
            text += f"{status_emoji} *ID: #{b['id']}*\n"
            text += f"Tipe: {b['message_type']}\n"
            text += f"Tgl: {b['created_at'][:16]}\n"
            text += f"Terkirim: {b['success_count']}/{b['total_recipients']}\n"
            text += f"Gagal: {b['fail_count']}\n"
            text += "─" * 30 + "\n"
        
        keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
        
        await safe_edit_message(
            query,
            text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    # ==================== ADMIN VIP MANAGEMENT ====================
    elif data.startswith('admin_view_user_') and is_admin(user.id):
        target_user_id = int(data.split('_')[3])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE user_id = ?", (target_user_id,))
            target_user = cursor.fetchone()
            
            if not target_user:
                await query.edit_message_text("❌ User tidak ditemukan!")
                return
            
            now = datetime.now()
            
            # Status VIP Regular
            vip_regular_status = "TIDAK AKTIF"
            vip_regular_icon = "❌"
            vip_regular_expired = "-"
            if target_user['vip_until']:
                try:
                    vip_date = datetime.fromisoformat(target_user['vip_until'])
                    if vip_date > now:
                        vip_regular_status = "AKTIF"
                        vip_regular_icon = "✅"
                        vip_regular_expired = vip_date.strftime('%d-%m-%Y')
                    else:
                        vip_regular_status = "EXPIRED"
                        vip_regular_icon = "⚠️"
                        vip_regular_expired = vip_date.strftime('%d-%m-%Y')
                except:
                    pass
            
            # Status VIP Limited
            vip_limited_status = "TIDAK AKTIF"
            vip_limited_icon = "❌"
            vip_limited_expired = "-"
            vip_limited_views = 0
            if target_user['vip_limited_until']:
                try:
                    limited_date = datetime.fromisoformat(target_user['vip_limited_until'])
                    if limited_date > now and target_user['vip_limited_views'] < target_user['vip_limited_total_views']:
                        vip_limited_status = "AKTIF"
                        vip_limited_icon = "✅"
                        vip_limited_expired = limited_date.strftime('%d-%m-%Y')
                        vip_limited_views = f"{target_user['vip_limited_views']}/{target_user['vip_limited_total_views']}"
                    else:
                        vip_limited_status = "EXPIRED"
                        vip_limited_icon = "⚠️"
                        vip_limited_expired = limited_date.strftime('%d-%m-%Y')
                        vip_limited_views = f"{target_user['vip_limited_views']}/{target_user['vip_limited_total_views']}"
                except:
                    pass
            
            cursor.execute("SELECT COUNT(*) as total FROM payments WHERE user_id = ?", (target_user_id,))
            total_order = cursor.fetchone()['total']
        
        text = (
            f"👤 <b>DATA USER</b>\n\n"
            f"ID: <code>{target_user_id}</code>\n"
            f"Nama: {target_user['first_name']}\n"
            f"Username: @{target_user['username'] or 'None'}\n"
            f"Bergabung: {target_user['joined_at'][:10]}\n\n"
            f"💎 <b>VIP Regular:</b> {vip_regular_icon} {vip_regular_status}\n"
            f"📅 Expired: {vip_regular_expired}\n\n"
            f"🔰 <b>VIP Limited:</b> {vip_limited_icon} {vip_limited_status}\n"
            f"📅 Expired: {vip_limited_expired}\n"
            f"👁 Kuota: {vip_limited_views}\n\n"
            f"🛒 Total Order: {total_order}"
        )
        
        keyboard = [
            [InlineKeyboardButton("➕ Tambah VIP Regular 7H", callback_data=f"admin_vip_add_regular_7_{target_user_id}")],
            [InlineKeyboardButton("➕ Tambah VIP Regular 30H", callback_data=f"admin_vip_add_regular_30_{target_user_id}")],
            [InlineKeyboardButton("🔰 Tambah VIP Limited 1H", callback_data=f"admin_vip_add_limited_1_{target_user_id}")],
            [InlineKeyboardButton("🔰 Tambah VIP Limited 3H", callback_data=f"admin_vip_add_limited_3_{target_user_id}")],
            [InlineKeyboardButton("❌ Hapus VIP Regular", callback_data=f"admin_vip_remove_regular_{target_user_id}")],
            [InlineKeyboardButton("❌ Hapus VIP Limited", callback_data=f"admin_vip_remove_limited_{target_user_id}")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_back")]
        ]
        
        await query.edit_message_text(
            text,
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    elif data.startswith('admin_vip_add_regular_') and is_admin(user.id):
        parts = data.split('_')
        days = int(parts[4])
        target_user_id = int(parts[5])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE user_id = ?", (target_user_id,))
            target_user = cursor.fetchone()
            
            if not target_user:
                await query.edit_message_text("❌ User tidak ditemukan!")
                return
            
            now = datetime.now()
            if target_user['vip_until']:
                try:
                    current_vip = datetime.fromisoformat(target_user['vip_until'])
                    if current_vip < now:
                        new_vip = now + timedelta(days=days)
                    else:
                        new_vip = current_vip + timedelta(days=days)
                except:
                    new_vip = now + timedelta(days=days)
            else:
                new_vip = now + timedelta(days=days)
            
            cursor.execute("UPDATE users SET vip_until = ? WHERE user_id = ?", (new_vip.isoformat(), target_user_id))
            conn.commit()
            
            try:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=(
                        f"✅ *VIP REGULAR DITAMBAHKAN OLEH ADMIN*\n\n"
                        f"Admin telah menambahkan {days} hari VIP Regular.\n\n"
                        f"📅 Berlaku sampai: {new_vip.strftime('%d %B %Y %H:%M')}\n"
                        f"Anda sekarang memiliki akses penuh ke semua video VIP!"
                    ),
                    parse_mode=ParseMode.MARKDOWN
                )
            except:
                pass
            
            await query.edit_message_text(
                f"✅ *Berhasil!*\n\n"
                f"User ID: `{target_user_id}`\n"
                f"Telah ditambahkan {days} hari VIP Regular.\n"
                f"Berlaku sampai: {new_vip.strftime('%d %B %Y %H:%M')}",
                parse_mode=ParseMode.MARKDOWN
            )
    
    elif data.startswith('admin_vip_add_limited_') and is_admin(user.id):
        parts = data.split('_')
        days = int(parts[4])
        target_user_id = int(parts[5])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM users WHERE user_id = ?", (target_user_id,))
            target_user = cursor.fetchone()
            
            if not target_user:
                await query.edit_message_text("❌ User tidak ditemukan!")
                return
            
            now = datetime.now()
            if target_user['vip_limited_until']:
                try:
                    current_limited = datetime.fromisoformat(target_user['vip_limited_until'])
                    if current_limited < now:
                        new_limited = now + timedelta(days=days)
                    else:
                        new_limited = current_limited + timedelta(days=days)
                except:
                    new_limited = now + timedelta(days=days)
            else:
                new_limited = now + timedelta(days=days)
            
            # Tentukan jumlah views berdasarkan durasi
            if days == 1:
                views = 2
            else:  # days == 3
                views = 6
            
            cursor.execute("""
                UPDATE users 
                SET vip_limited_until = ?, 
                    vip_limited_views = 0,
                    vip_limited_total_views = ? 
                WHERE user_id = ?
            """, (new_limited.isoformat(), views, target_user_id))
            conn.commit()
            
            try:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=(
                        f"🔰 *VIP LIMITED DITAMBAHKAN OLEH ADMIN*\n\n"
                        f"Admin telah menambahkan {days} hari VIP Limited.\n\n"
                        f"📅 Berlaku sampai: {new_limited.strftime('%d %B %Y %H:%M')}\n"
                        f"👁 Kuota: {views}x lihat video VIP\n\n"
                        f"Silakan nikmati video VIP!"
                    ),
                    parse_mode=ParseMode.MARKDOWN
                )
            except:
                pass
            
            await query.edit_message_text(
                f"✅ *Berhasil!*\n\n"
                f"User ID: `{target_user_id}`\n"
                f"Telah ditambahkan {days} hari VIP Limited ({views}x lihat).\n"
                f"Berlaku sampai: {new_limited.strftime('%d %B %Y %H:%M')}",
                parse_mode=ParseMode.MARKDOWN
            )
    
    elif data.startswith('admin_vip_remove_regular_') and is_admin(user.id):
        target_user_id = int(data.split('_')[4])
        
        keyboard = [
            [
                InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"admin_vip_remove_regular_confirm_{target_user_id}"),
                InlineKeyboardButton("❌ Batal", callback_data=f"admin_view_user_{target_user_id}")
            ]
        ]
        
        await query.edit_message_text(
            f"⚠️ <b>KONFIRMASI HAPUS VIP REGULAR</b>\n\n"
            f"Anda akan menghapus status VIP Regular user ID: <code>{target_user_id}</code>\n\n"
            f"Yakin ingin melanjutkan?",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    elif data.startswith('admin_vip_remove_regular_confirm_') and is_admin(user.id):
        target_user_id = int(data.split('_')[5])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET vip_until = NULL WHERE user_id = ?", (target_user_id,))
            conn.commit()
            
            try:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=(
                        f"❌ *VIP REGULAR DIHAPUS OLEH ADMIN*\n\n"
                        f"Status VIP Regular Anda telah dihapus oleh admin.\n"
                        f"Silakan hubungi admin untuk informasi lebih lanjut."
                    ),
                    parse_mode=ParseMode.MARKDOWN
                )
            except:
                pass
        
        keyboard = [[InlineKeyboardButton("🔍 Lihat Detail User", callback_data=f"admin_view_user_{target_user_id}")]]
        
        await query.edit_message_text(
            f"✅ *Berhasil!*\n\n"
            f"Status VIP Regular user ID: `{target_user_id}` telah dihapus.",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data.startswith('admin_vip_remove_limited_') and is_admin(user.id):
        target_user_id = int(data.split('_')[4])
        
        keyboard = [
            [
                InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"admin_vip_remove_limited_confirm_{target_user_id}"),
                InlineKeyboardButton("❌ Batal", callback_data=f"admin_view_user_{target_user_id}")
            ]
        ]
        
        await query.edit_message_text(
            f"⚠️ <b>KONFIRMASI HAPUS VIP LIMITED</b>\n\n"
            f"Anda akan menghapus status VIP Limited user ID: <code>{target_user_id}</code>\n\n"
            f"Yakin ingin melanjutkan?",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    elif data.startswith('admin_vip_remove_limited_confirm_') and is_admin(user.id):
        target_user_id = int(data.split('_')[5])
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("UPDATE users SET vip_limited_until = NULL, vip_limited_views = 0 WHERE user_id = ?", (target_user_id,))
            conn.commit()
            
            try:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=(
                        f"❌ *VIP LIMITED DIHAPUS OLEH ADMIN*\n\n"
                        f"Status VIP Limited Anda telah dihapus oleh admin.\n"
                        f"Silakan hubungi admin untuk informasi lebih lanjut."
                    ),
                    parse_mode=ParseMode.MARKDOWN
                )
            except:
                pass
        
        keyboard = [[InlineKeyboardButton("🔍 Lihat Detail User", callback_data=f"admin_view_user_{target_user_id}")]]
        
        await query.edit_message_text(
            f"✅ *Berhasil!*\n\n"
            f"Status VIP Limited user ID: `{target_user_id}` telah dihapus.",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.MARKDOWN
        )
    
    elif data == "admin_back" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) as total FROM videos")
            result = cursor.fetchone()
            total_videos = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM users")
            result = cursor.fetchone()
            total_users = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_until > datetime('now')")
            result = cursor.fetchone()
            active_vip_regular = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM users WHERE vip_limited_until > datetime('now')")
            result = cursor.fetchone()
            active_vip_limited = result['total'] if result else 0
            
            cursor.execute("SELECT COUNT(*) as total FROM payments WHERE status = 'PENDING'")
            result = cursor.fetchone()
            pending_payments = result['total'] if result else 0
        
        keyboard = [
            [InlineKeyboardButton("👥 Cek User", callback_data="admin_check_user")],
            [InlineKeyboardButton("📊 Statistik", callback_data="admin_stats")],
            [InlineKeyboardButton("💰 Pembayaran Pending", callback_data="admin_payments_pending")],
            [InlineKeyboardButton("🎟️ Kode Redeem VIP", callback_data="admin_redeem_menu")],
            [InlineKeyboardButton("🔥 Status DB Online", callback_data="admin_db_status")],
            [InlineKeyboardButton("📢 Broadcast", callback_data="admin_broadcast_menu")],
            [InlineKeyboardButton("📋 Riwayat Broadcast", callback_data="admin_broadcast_history")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="back_main")]
        ]
        
        await safe_edit_message(
            query,
            f"👑 <b>ADMIN PANEL</b>\n\n"
            f"📊 Statistik:\n"
            f"• Total Video: {total_videos}\n"
            f"• Total User: {total_users}\n"
            f"• VIP Regular Aktif: {active_vip_regular}\n"
            f"• VIP Limited Aktif: {active_vip_limited}\n\n"
            f"💳 Pembayaran Pending: {pending_payments}\n\n"
            f"Silakan pilih menu:",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode=ParseMode.HTML
        )
    
    # ==================== DB STATUS (FIREBASE) ====================
    elif data == "admin_db_status" and is_admin(user.id):
        fb_db = firebase_sync.get_db()
        
        if fb_db is None:
            text = (
                "🔥 <b>STATUS DATABASE ONLINE</b>\n\n"
                "❌ <b>Status: OFFLINE / ERROR</b>\n\n"
                "Firebase tidak terhubung.\n"
                "Cek file firebase-key.json dan koneksi internet."
            )
            keyboard = [[InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]]
            await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
            return
        
        try:
            # Ambil statistik dari Firebase
            users_ref = fb_db.collection('users')
            videos_ref = fb_db.collection('videos')
            payments_ref = fb_db.collection('payments')
            stats_ref = fb_db.collection('stats')
            redeem_ref = fb_db.collection('redeem_codes')
            
            # Count dokumen (menggunakan metode .count().get())
            def get_count(ref):
                try:
                    return ref.count().get()[0][0].value
                except:
                    return 0

            users_total = get_count(users_ref)
            videos_total = get_count(videos_ref)
            payments_total = get_count(payments_ref)
            stats_total = get_count(stats_ref)
            redeem_total = get_count(redeem_ref)
            
            # Ambil data terakhir
            last_video = list(videos_ref.order_by('uploaded_at', direction='DESCENDING').limit(1).stream())
            last_payment = list(payments_ref.order_by('created_at', direction='DESCENDING').limit(1).stream())
            last_user = list(users_ref.order_by('joined_at', direction='DESCENDING').limit(1).stream())
            last_stat = list(stats_ref.order_by('timestamp', direction='DESCENDING').limit(1).stream())
            
            # Format info terakhir
            def fmt_time(doc, field):
                if doc:
                    d = doc[0].to_dict()
                    val = d.get(field)
                    if val:
                        if hasattr(val, 'strftime'):
                            return val.strftime('%d/%m/%Y %H:%M')
                        return str(val)[:16]
                return '-'
            
            def fmt_field(doc, field, default='-'):
                if doc:
                    d = doc[0].to_dict()
                    return d.get(field, default)
                return default
            
            last_video_title = fmt_field(last_video, 'caption', 'Tanpa Judul')
            last_video_time = fmt_time(last_video, 'uploaded_at')
            last_video_code = fmt_field(last_video, 'code', '-')
            
            last_payment_amount = fmt_field(last_payment, 'amount', 0)
            last_payment_status = fmt_field(last_payment, 'status', '-')
            last_payment_time = fmt_time(last_payment, 'created_at')
            
            last_user_name = fmt_field(last_user, 'first_name', '-')
            last_user_time = fmt_time(last_user, 'joined_at')
            
            last_stat_action = fmt_field(last_stat, 'action', '-')
            last_stat_time = fmt_time(last_stat, 'timestamp')
            
            text = (
                "🔥 <b>STATUS DATABASE ONLINE</b>\n\n"
                "✅ <b>Status: ONLINE</b>\n"
                f"☁️ Project: <code>botfsub-85a55</code>\n\n"
                "━━━━ 📊 <b>JUMLAH DATA</b> ━━━━\n"
                f"👤 Users: <b>{users_total}</b>\n"
                f"🎬 Videos: <b>{videos_total}</b>\n"
                f"💳 Payments: <b>{payments_total}</b>\n"
                f"📊 Stats: <b>{stats_total}</b>\n"
                f"🎟️ Redeem: <b>{redeem_total}</b>\n\n"
                "━━━━ 🕒 <b>DATA TERAKHIR</b> ━━━━\n"
                f"🎬 <b>Video Terakhir:</b>\n"
                f"   ├ Judul: {last_video_title}\n"
                f"   ├ Kode: <code>{last_video_code}</code>\n"
                f"   └ Waktu: {last_video_time}\n\n"
                f"💳 <b>Pembayaran Terakhir:</b>\n"
                f"   ├ Amount: Rp {last_payment_amount:,}\n"
                f"   ├ Status: {last_payment_status}\n"
                f"   └ Waktu: {last_payment_time}\n\n"
                f"👤 <b>User Terakhir:</b>\n"
                f"   ├ Nama: {last_user_name}\n"
                f"   └ Daftar: {last_user_time}\n\n"
                f"📊 <b>Aktivitas Terakhir:</b>\n"
                f"   ├ Aksi: {last_stat_action}\n"
                f"   └ Waktu: {last_stat_time}"
            )
        except Exception as e:
            logger.error(f"Error mengambil status Firebase: {e}")
            text = (
                "🔥 <b>STATUS DATABASE ONLINE</b>\n\n"
                f"⚠️ <b>Status: ERROR</b>\n\n"
                f"Kesalahan: <code>{str(e)[:200]}</code>"
            )
        
        keyboard = [
            [InlineKeyboardButton("🔄 Refresh", callback_data="admin_db_status")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
    
    # ==================== REDEEM CODE MENU ====================
    elif data == "admin_redeem_menu" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            # Kode aktif = belum expired DAN belum limit
            cursor.execute("""
                SELECT COUNT(*) as total FROM redeem_codes rc
                WHERE expires_at > datetime('now')
                AND (SELECT COUNT(*) FROM redeem_history WHERE code_id = rc.id) < rc.max_redeems
            """)
            active_codes = cursor.fetchone()['total']
            
            # Kode limit = sudah mencapai max_redeems
            cursor.execute("""
                SELECT COUNT(*) as total FROM redeem_codes rc
                WHERE (SELECT COUNT(*) FROM redeem_history WHERE code_id = rc.id) >= rc.max_redeems
            """)
            limited_codes = cursor.fetchone()['total']
            
            cursor.execute("""
                SELECT rc.* FROM redeem_codes rc
                WHERE expires_at > datetime('now')
                AND (SELECT COUNT(*) FROM redeem_history WHERE code_id = rc.id) < rc.max_redeems
                ORDER BY created_at DESC LIMIT 5
            """)
            recent_codes = cursor.fetchall()
        
        code_list = ""
        if recent_codes:
            for rc in recent_codes:
                with get_db() as conn2:
                    c2 = conn2.cursor()
                    c2.execute("SELECT COUNT(*) as total FROM redeem_history WHERE code_id = ?", (rc['id'],))
                    current = c2.fetchone()['total']
                expires = datetime.fromisoformat(rc['expires_at']).strftime('%d/%m %H:%M')
                code_list += f"  <code>{rc['code']}</code> → {current}/{rc['max_redeems']} User | exp: {expires}\n"
        else:
            code_list = "  <i>Belum ada kode aktif</i>\n"
        
        text = (
            "🎟️ <b>KODE REDEEM VIP</b>\n\n"
            f"✅ Kode Aktif: <b>{active_codes}</b>\n"
            f"🚫 Kode Limit/Habis: <b>{limited_codes}</b>\n\n"
            "━━━━ 📋 <b>KODE AKTIF TERBARU</b> ━━━━\n"
            f"{code_list}\n"
            "Pilih aksi:"
        )
        
        keyboard = [
            [
                InlineKeyboardButton("➕ Buat Kode Baru", callback_data="admin_redeem_sel_menu"),
                InlineKeyboardButton("🚫 Lihat Kode Limit", callback_data="admin_redeem_list_limit")
            ],
            [
                InlineKeyboardButton("🗑 Hapus Expired", callback_data="admin_redeem_clean"),
                InlineKeyboardButton("🔥 Hapus Semua Limit", callback_data="admin_redeem_clean_limit")
            ],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_panel")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data == "admin_redeem_list_limit" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT rc.* FROM redeem_codes rc
                WHERE (SELECT COUNT(*) FROM redeem_history WHERE code_id = rc.id) >= rc.max_redeems
                ORDER BY created_at DESC LIMIT 10
            """)
            limit_codes = cursor.fetchall()
        
        list_text = ""
        if limit_codes:
            for rc in limit_codes:
                list_text += f"  ❌ <code>{rc['code']}</code> (Batas: {rc['max_redeems']} User)\n"
        else:
            list_text = "  <i>Belum ada kode yang limit</i>\n"
            
        text = (
            "🚫 <b>DAFTAR KODE LIMIT (HABIS)</b>\n\n"
            "Kode-kode di bawah ini sudah mencapai batas maksimal penggunaan oleh user:\n\n"
            f"{list_text}\n"
            "Anda bisa menghapus kode ini untuk mengosongkan database."
        )
        keyboard = [
            [InlineKeyboardButton("🔥 Hapus Semua Kode Limit", callback_data="admin_redeem_clean_limit")],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_redeem_menu")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data == "admin_redeem_sel_menu" and is_admin(user.id):
        text = "Pilih kuota tonton untuk kode baru:"
        keyboard = [
            [
                InlineKeyboardButton("➕ Kuota 2x", callback_data="admin_redeem_sel_2"),
                InlineKeyboardButton("➕ Kuota 4x", callback_data="admin_redeem_sel_4")
            ],
            [
                InlineKeyboardButton("➕ Kuota 10x", callback_data="admin_redeem_sel_10"),
                InlineKeyboardButton("➕ Kuota 20x", callback_data="admin_redeem_sel_20")
            ],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_redeem_menu")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data.startswith("admin_redeem_sel_") and is_admin(user.id):
        views = int(data.split("_")[-1])
        text = (
            f"🎟️ <b>BUAT KODE (KUOTA {views}x)</b>\n\n"
            "Pilih <b>Batas Maksimal User</b> yang bisa redeem kode ini:"
        )
        keyboard = [
            [
                InlineKeyboardButton("👤 1 User", callback_data=f"admin_redeem_lim_{views}_1"),
                InlineKeyboardButton("👥 10 User", callback_data=f"admin_redeem_lim_{views}_10")
            ],
            [
                InlineKeyboardButton("👥 50 User", callback_data=f"admin_redeem_lim_{views}_50"),
                InlineKeyboardButton("🌍 100 User", callback_data=f"admin_redeem_lim_{views}_100")
            ],
            [InlineKeyboardButton("🔙 Kembali", callback_data="admin_redeem_menu")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data.startswith("admin_redeem_lim_") and is_admin(user.id):
        parts = data.split("_")
        views = int(parts[3])
        limit = int(parts[4])
        text = (
            f"🎟️ <b>BUAT KODE</b>\n\n"
            f"👁 Kuota: {views}x tonton\n"
            f"👥 Batas: {limit} User\n\n"
            "Pilih jumlah kode yang ingin dibuat:"
        )
        keyboard = [
            [
                InlineKeyboardButton("🏷 Buat 1 Kode", callback_data=f"admin_redeem_gen_{views}_{limit}_1"),
                InlineKeyboardButton("🏷 Buat 5 Kode", callback_data=f"admin_redeem_gen_{views}_{limit}_5")
            ],
            [InlineKeyboardButton("🔙 Kembali", callback_data=f"admin_redeem_sel_{views}")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data.startswith("admin_redeem_gen_") and is_admin(user.id):
        parts = data.split("_")
        views = int(parts[3])
        limit = int(parts[4])
        count = int(parts[5])
        created_codes = []
        expires_at = (datetime.now() + timedelta(days=1)).isoformat()
        
        with get_db() as conn:
            cursor = conn.cursor()
            for _ in range(count):
                code = generate_redeem_code()
                while True:
                    cursor.execute("SELECT id FROM redeem_codes WHERE code = ?", (code,))
                    if not cursor.fetchone(): break
                    code = generate_redeem_code()
                
                cursor.execute("""
                    INSERT INTO redeem_codes (code, days, max_views, max_redeems, created_by, expires_at)
                    VALUES (?, 1, ?, ?, ?, ?)
                """, (code, views, limit, user.id, expires_at))
                created_codes.append(code)
                
                firebase_sync._safe_sync('redeem_codes', code, {
                    'code': code, 'days': 1, 'max_views': views, 'max_redeems': limit,
                    'created_by': user.id, 'expires_at': expires_at,
                    'created_at': datetime.now().isoformat()
                })
            conn.commit()
        
        codes_text = "\n".join([f"  <code>{c}</code>" for c in created_codes])
        text = (
            f"✅ <b>{count} Kode Berhasil Dibuat!</b>\n\n"
            f"🎟️ Kode:\n{codes_text}\n\n"
            f"👁 Kuota: <b>{views}x tonton</b>\n"
            f"👥 Batas: <b>{limit} User per kode</b>\n"
            f"⏰ Exp: 1 Hari"
        )
        keyboard = [
            [InlineKeyboardButton("🎟️ Menu Redeem", callback_data="admin_redeem_menu")],
            [InlineKeyboardButton("🔙 Admin Panel", callback_data="admin_panel")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

    elif data == "admin_redeem_clean" and is_admin(user.id):
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT code FROM redeem_codes WHERE expires_at <= datetime('now')")
            expired = cursor.fetchall()
            cursor.execute("DELETE FROM redeem_codes WHERE expires_at <= datetime('now')")
            deleted = cursor.rowcount
            conn.commit()
            for row in expired:
                fb_db = firebase_sync.get_db()
                if fb_db:
                    try: fb_db.collection('redeem_codes').document(row['code']).delete()
                    except: pass
        
        text = f"🗑 <b>{deleted} kode expired berhasil dihapus!</b>"
        keyboard = [
            [InlineKeyboardButton("🎟️ Menu Redeem", callback_data="admin_redeem_menu")],
            [InlineKeyboardButton("🔙 Admin Panel", callback_data="admin_panel")]
        ]
        await safe_edit_message(query, text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
    
    # ==================== BACK TO MAIN ====================
    elif data == "back_main":
        user_info = get_user_or_create(user.id, user.username, user.first_name)
        
        welcome_text = (
            f"👋 Hallo {user.first_name}!\n\n"
            f"Selamat Bergabung di Short Drama Team DL\n\n"
            f"Gunakan perintah /status untuk melihat status membership Anda.\n"
            f"Ketik /vip untuk info pembelian VIP.\n"
            f"Ketik /cari untuk mencari video.\n"
            f"Klik link video untuk memutar langsung."
        )
        
        keyboard = [
            [InlineKeyboardButton("💎 STATUS MEMBERSHIP", callback_data="vip_status")],
            [InlineKeyboardButton("🛍️ BELI PAKET VIP", callback_data="buy_vip")],
            [InlineKeyboardButton("🎁 REDEEM KODE VIP", callback_data="user_redeem_start")],
            [InlineKeyboardButton("🔍 CARI VIDEO DRAMA", callback_data="search_again")],
            [InlineKeyboardButton("👨‍💻 KONTAK ADMIN", url=f"tg://user?id={ADMIN_IDS[0]}")]
        ]
        
        if is_admin(user.id):
            keyboard.append([InlineKeyboardButton("⚙️ Panel Admin", callback_data="admin_panel")])
        
        await safe_edit_message(
            query,
            welcome_text,
            reply_markup=InlineKeyboardMarkup(keyboard)
        )

# ===================== MESSAGE HANDLER =====================
async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk pesan teks"""
    user = update.effective_user
    
    # CEK STATE ADMIN CHAT KE USER
    if context.user_data.get('waiting_admin_chat') and is_admin(user.id):
        target_id = context.user_data.get('waiting_admin_chat')
        msg_text = update.message.text
        context.user_data.pop('waiting_admin_chat', None)
        
        try:
            await context.bot.send_message(
                chat_id=target_id,
                text=f"✉️ <b>PESAN DARI ADMIN</b>\n\n{msg_text}",
                parse_mode=ParseMode.HTML
            )
            await update.message.reply_text(f"✅ Pesan berhasil terkirim ke user <code>{target_id}</code>", parse_mode=ParseMode.HTML)
        except Exception as e:
            await update.message.reply_text(f"❌ Gagal mengirim pesan: {e}")
        return

    # CEK STATE WAITING ADD VIP ID
    if context.user_data.get('admin_mode') == 'waiting_add_vip_id' and is_admin(user.id):
        target_id = update.message.text.strip()
        context.user_data['temp_vip_id'] = target_id
        context.user_data['admin_mode'] = 'waiting_add_vip_days'
        
        await update.message.reply_text(
            f"👤 User ID: <code>{target_id}</code>\n\n"
            f"Berapa <b>jumlah hari</b> VIP yang ingin diberikan?\n"
            f"Contoh: <code>30</code>\n\n"
            f"Tipe default adalah <b>REGULAR</b>.",
            parse_mode=ParseMode.HTML
        )
        return

    # CEK STATE WAITING ADD VIP DAYS
    if context.user_data.get('admin_mode') == 'waiting_add_vip_days' and is_admin(user.id):
        days_str = update.message.text.strip()
        target_id = context.user_data.get('temp_vip_id')
        context.user_data.pop('admin_mode', None)
        context.user_data.pop('temp_vip_id', None)
        
        try:
            # Gunakan fungsi addvip_command yang sudah ada dengan simulasi context.args
            context.args = [target_id, days_str, "regular"]
            await addvip_command(update, context)
        except Exception as e:
            await update.message.reply_text(f"❌ Gagal memproses: {e}")
        return

    # CEK STATE WAITING REMOVE VIP ID
    if context.user_data.get('admin_mode') == 'waiting_remove_vip_id' and is_admin(user.id):
        target_id = update.message.text.strip()
        context.user_data.pop('admin_mode', None)
        
        try:
            user_id = int(target_id)
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("UPDATE users SET vip_until = NULL, vip_limited_until = NULL, vip_type = 'FREE' WHERE user_id = ?", (user_id,))
                conn.commit()
            
            # Sync ke Firebase
            firebase_sync.sync_user_vip_clear(user_id, clear_regular=True, clear_limited=True)
            
            await update.message.reply_text(f"✅ Status VIP untuk user <code>{user_id}</code> berhasil <b>DIHAPUS</b>.", parse_mode=ParseMode.HTML)
        except Exception as e:
            await update.message.reply_text(f"❌ Gagal menghapus VIP: {e}")
        return

    # CEK STATE WAITING CHECK USER (BARU)
    if context.user_data.get('admin_mode') == 'waiting_user_id' and is_admin(user.id):
        target_id_str = update.message.text.strip()
        context.user_data.pop('admin_mode', None)
        
        try:
            # Panggil fungsi cekuser yang sudah kita buat sebelumnya
            context.args = [target_id_str]
            await cekuser_command(update, context)
        except Exception as e:
            await update.message.reply_text(f"❌ Gagal memproses ID: {e}")
        return

    # CEK STATE WAITING DELETE VIDEO
    if context.user_data.get('admin_mode') == 'waiting_delete_video' and is_admin(user.id):
        keyword = update.message.text.strip()
        context.user_data.pop('admin_mode', None)
        
        with get_db() as conn:
            cursor = conn.cursor()
            # Cari berdasarkan kode atau judul
            cursor.execute("SELECT * FROM videos WHERE code = ? OR caption LIKE ?", (keyword, f"%{keyword}%"))
            video = cursor.fetchone()
            
            if video:
                text = (
                    "⚠️ <b>KONFIRMASI HAPUS VIDEO</b>\n\n"
                    f"🎬 Judul: <b>{video['caption']}</b>\n"
                    f"📌 Kode: <code>{video['code']}</code>\n"
                    f"👤 Uploader: {video['uploader_name']}\n\n"
                    "Yakin ingin menghapus video ini secara permanen?"
                )
                keyboard = [
                    [
                        InlineKeyboardButton("✅ Ya, Hapus", callback_data=f"video_delete_confirm_{video['id']}"),
                        InlineKeyboardButton("❌ Batal", callback_data="admin_panel")
                    ]
                ]
                await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)
            else:
                await update.message.reply_text(f"❌ Video dengan keyword '<code>{keyword}</code>' tidak ditemukan!", parse_mode=ParseMode.HTML)
        return
    
    # CEK STATE WAITING REDEEM
    if context.user_data.get('waiting_redeem'):
        code = update.message.text.strip()
        context.user_data.pop('waiting_redeem', None)
        
        # Simulasikan pemanggilan perintah /redeem
        context.args = [code]
        await redeem_command(update, context)
        return
    
    # CEK STATE WAITING SEARCH
    if context.user_data.get('waiting_search'):
        keyword = update.message.text.strip()
        
        if len(keyword) < 3:
            await update.message.reply_text("❌ Keyword terlalu pendek.\nMinimal 3 karakter.")
            return
        
        context.user_data['last_search_keyword'] = keyword
        context.user_data.pop('waiting_search', None)
        
        await perform_search(update, context, keyword, page=1)
        return
    
    # CEK STATE WAITING BROADCAST
    if context.user_data.get('broadcast_mode') == 'waiting_content' and is_admin(user.id):
        await handle_broadcast_content(update, context)
        return
    
    # CEK STATE WAITING REJECT REASON
    if context.user_data.get('waiting_reject_reason') and is_admin(user.id):
        reject_reason = update.message.text
        payment_id = context.user_data.get('reject_payment_id')
        
        if not payment_id:
            context.user_data.clear()
            await update.message.reply_text("❌ Sesi penolakan berakhir.")
            return
        
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM payments WHERE id = ?", (payment_id,))
            payment = cursor.fetchone()
            
            if not payment:
                await update.message.reply_text(f"❌ Pembayaran #{payment_id} tidak ditemukan!")
                context.user_data.clear()
                return
            
            if payment['status'] != 'PENDING':
                await update.message.reply_text(f"❌ Pembayaran #{payment_id} sudah diproses!")
                context.user_data.clear()
                return
            
            cursor.execute("""
                UPDATE payments 
                SET status = 'REJECTED', 
                    rejected_reason = ?, 
                    approved_by = ?, 
                    approved_at = ?
                WHERE id = ?
            """, (reject_reason, user.id, datetime.now().isoformat(), payment_id))
            conn.commit()
            
            try:
                await context.bot.send_message(
                    chat_id=payment['user_id'],
                    text=(
                        f"❌ *PEMBAYARAN DITOLAK*\n\n"
                        f"Maaf, pembayaran Anda tidak dapat diproses.\n\n"
                        f"📦 Paket: {payment['days']} Hari ({payment['payment_type']})\n"
                        f"💰 Total: Rp {payment['amount']:,}\n"
                        f"❌ Alasan: {reject_reason}\n\n"
                        f"Silakan hubungi admin atau lakukan pembayaran ulang."
                    ),
                    parse_mode=ParseMode.MARKDOWN
                )
            except Exception as e:
                logger.error(f"Failed to send rejection: {e}")
            
            await update.message.reply_text(
                f"✅ *Pembayaran #{payment_id} telah DITOLAK*\n\n"
                f"Alasan: {reject_reason}",
                parse_mode=ParseMode.MARKDOWN
            )
            
            context.user_data.clear()
            return
    
    # CEK STATE WAITING SOURCE LINK
    if context.user_data.get('admin_mode') == 'waiting_source_link' and is_admin(user.id):
        link = update.message.text.strip()
        context.user_data.pop('admin_mode', None)
        
        # Ekstrak chat_id dan thread_id dari link
        chat_id = None
        thread_id = None
        
        try:
            if "t.me/c/" in link: # Private group link: https://t.me/c/123456789/10
                parts = link.split("/")
                chat_id = int("-100" + parts[-2])
                thread_id = int(parts[-1])
            elif "t.me/" in link: # Public group link
                parts = link.split("/")
                username = parts[-2] if len(parts) > 4 else parts[-1]
                chat = await context.bot.get_chat(username)
                chat_id = chat.id
                if len(parts) > 4:
                    thread_id = int(parts[-1])
            
            if chat_id:
                # Cek apakah bot admin
                member = await context.bot.get_chat_member(chat_id, context.bot.id)
                is_admin_bot = member.status in ['administrator', 'creator']
                
                chat_info = await context.bot.get_chat(chat_id)
                title = chat_info.title
                
                with get_db() as conn:
                    cursor = conn.cursor()
                    cursor.execute("""
                        INSERT OR REPLACE INTO source_groups (chat_id, thread_id, title, link, is_active)
                        VALUES (?, ?, ?, ?, ?)
                    """, (chat_id, thread_id, title, link, 1 if is_admin_bot else 0))
                    conn.commit()
                
                await update.message.reply_text(
                    f"✅ <b>GRUP BERHASIL DIDAFTARKAN!</b>\n\n"
                    f"📍 Judul: <b>{title}</b>\n"
                    f"🆔 Chat ID: <code>{chat_id}</code>\n"
                    f"🧵 Topic ID: <code>{thread_id or 'Grup Biasa'}</code>\n"
                    f"🛡 Status Admin: {'✅ Aktif' if is_admin_bot else '❌ Bukan Admin'}\n\n"
                    f"Bot akan mulai membaca video dari grup ini secara otomatis.",
                    parse_mode=ParseMode.HTML
                )
            else:
                raise ValueError("Link tidak valid")
        except Exception as e:
            await update.message.reply_text(f"❌ <b>Gagal mendaftarkan grup!</b>\n\nKesalahan: {e}", parse_mode=ParseMode.HTML)
        return
    
    # CEK STATE WAITING USER ID

        try:
            target_user_id = int(update.message.text.strip())
            
            context.user_data.pop("admin_mode", None)
            
            with get_db() as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT * FROM users WHERE user_id = ?", (target_user_id,))
                target_user = cursor.fetchone()
                
                if not target_user:
                    await update.message.reply_text(
                        "❌ User tidak ditemukan di database!\n\n"
                        "Pastikan User ID benar dan user sudah pernah memulai bot."
                    )
                    return
                
                now = datetime.now()
                
                # Status VIP Regular
                vip_regular_status = "TIDAK AKTIF"
                vip_regular_icon = "❌"
                vip_regular_expired = "-"
                if target_user['vip_until']:
                    try:
                        vip_date = datetime.fromisoformat(target_user['vip_until'])
                        if vip_date > now:
                            vip_regular_status = "AKTIF"
                            vip_regular_icon = "✅"
                            vip_regular_expired = vip_date.strftime('%d-%m-%Y')
                        else:
                            vip_regular_status = "EXPIRED"
                            vip_regular_icon = "⚠️"
                            vip_regular_expired = vip_date.strftime('%d-%m-%Y')
                    except:
                        pass
                
                # Status VIP Limited
                vip_limited_status = "TIDAK AKTIF"
                vip_limited_icon = "❌"
                vip_limited_expired = "-"
                vip_limited_views = 0
                if target_user['vip_limited_until']:
                    try:
                        limited_date = datetime.fromisoformat(target_user['vip_limited_until'])
                        if limited_date > now and target_user['vip_limited_views'] < target_user['vip_limited_total_views']:
                            vip_limited_status = "AKTIF"
                            vip_limited_icon = "✅"
                            vip_limited_expired = limited_date.strftime('%d-%m-%Y')
                            vip_limited_views = f"{target_user['vip_limited_views']}/{target_user['vip_limited_total_views']}"
                        else:
                            vip_limited_status = "EXPIRED"
                            vip_limited_icon = "⚠️"
                            vip_limited_expired = limited_date.strftime('%d-%m-%Y')
                            vip_limited_views = f"{target_user['vip_limited_views']}/{target_user['vip_limited_total_views']}"
                    except:
                        pass
                
                cursor.execute("SELECT COUNT(*) as total FROM payments WHERE user_id = ?", (target_user_id,))
                total_order = cursor.fetchone()['total']
            
            text = (
                f"👤 <b>DATA USER</b>\n\n"
                f"ID: <code>{target_user_id}</code>\n"
                f"Nama: {target_user['first_name']}\n"
                f"Username: @{target_user['username'] or 'None'}\n"
                f"Bergabung: {target_user['joined_at'][:10]}\n\n"
                f"💎 <b>VIP Regular:</b> {vip_regular_icon} {vip_regular_status}\n"
                f"📅 Expired: {vip_regular_expired}\n\n"
                f"🔰 <b>VIP Limited:</b> {vip_limited_icon} {vip_limited_status}\n"
                f"📅 Expired: {vip_limited_expired}\n"
                f"👁 Kuota: {vip_limited_views}\n\n"
                f"🛒 Total Order: {total_order}"
            )
            
            keyboard = [
                [InlineKeyboardButton("➕ Tambah VIP Regular 7H", callback_data=f"admin_vip_add_regular_7_{target_user_id}")],
                [InlineKeyboardButton("➕ Tambah VIP Regular 30H", callback_data=f"admin_vip_add_regular_30_{target_user_id}")],
                [InlineKeyboardButton("🔰 Tambah VIP Limited 1H", callback_data=f"admin_vip_add_limited_1_{target_user_id}")],
                [InlineKeyboardButton("🔰 Tambah VIP Limited 3H", callback_data=f"admin_vip_add_limited_3_{target_user_id}")],
                [InlineKeyboardButton("❌ Hapus VIP Regular", callback_data=f"admin_vip_remove_regular_{target_user_id}")],
                [InlineKeyboardButton("❌ Hapus VIP Limited", callback_data=f"admin_vip_remove_limited_{target_user_id}")],
                [InlineKeyboardButton("🔙 Kembali", callback_data="admin_back")]
            ]
            
            await update.message.reply_text(
                text,
                reply_markup=InlineKeyboardMarkup(keyboard),
                parse_mode=ParseMode.HTML
            )
            return
                
        except ValueError:
            await update.message.reply_text(
                "❌ <b>Format User ID tidak valid!</b>\n\n"
                "User ID harus berupa angka.\n"
                "Contoh: <code>5888747846</code>",
                parse_mode=ParseMode.HTML
            )
            return

# ===================== ADMIN COMMANDS =====================
async def listgroup_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /listgroup - Melihat daftar grup sumber (Admin Only)"""
    user = update.effective_user
    if not is_admin(user.id):
        return

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM source_groups ORDER BY created_at DESC")
        sources = cursor.fetchall()

    if not sources:
        await update.message.reply_text("❌ Belum ada grup atau topik yang terdaftar.")
        return

    text = "📡 <b>DAFTAR GRUP SUMBER</b>\n\n"
    for i, s in enumerate(sources, 1):
        topic_str = f" | Topik ID: <code>{s['thread_id']}</code>" if s['thread_id'] else " | (Grup Biasa)"
        text += f"{i}. 📍 <b>{s['title'] or 'Tanpa Judul'}</b>\n"
        text += f"   🆔 ID: <code>{s['chat_id']}</code>{topic_str}\n"
        text += f"   🔗 Link: {s['link'] or '-'}\n\n"

    keyboard = [[InlineKeyboardButton("⚙️ MANAJEMEN GRUP", callback_data="admin_source_menu")]]
    await update.message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard), parse_mode=ParseMode.HTML)

# ===================== HANDLER CANCEL =====================
async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk perintah /cancel"""
    user = update.effective_user
    
    if context.user_data:
        if context.user_data.get("admin_mode") == "waiting_user_id":
            logger.info(f"Admin {user.id} cancelled user ID input")
            context.user_data.pop("admin_mode", None)
            await update.message.reply_text("✅ Pengecekan user dibatalkan.")
        elif context.user_data.get('broadcast_mode') == 'waiting_content':
            logger.info(f"Admin {user.id} cancelled broadcast")
            context.user_data.pop('broadcast_mode', None)
            context.user_data.pop('broadcast_data', None)
            await update.message.reply_text("✅ Broadcast dibatalkan.")
        elif 'waiting_search' in context.user_data:
            logger.info(f"User {user.id} cancelled search")
            context.user_data.pop('waiting_search', None)
            await update.message.reply_text("✅ Pencarian dibatalkan.")
        elif 'waiting_reject_reason' in context.user_data:
            payment_id = context.user_data.get('reject_payment_id')
            logger.info(f"Admin {user.id} cancelled rejection for payment #{payment_id}")
            context.user_data.clear()
            await update.message.reply_text("✅ Penolakan dibatalkan.")
        else:
            await update.message.reply_text("✅ Operasi dibatalkan.")
            context.user_data.clear()
    else:
        await update.message.reply_text("✅ Tidak ada operasi yang sedang berjalan.")

# ===================== HANDLER UNTUK GRUP =====================
async def group_command_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handler untuk command yang dipanggil di grup"""
    command = update.message.text.split()[0][1:].lower()
    
    logger.info(f"Command '{command}' digunakan di GRUP oleh user {update.effective_user.id}")
    
    if command == "vip":
        await vip_command(update, context)
    elif command == "start":
        keyboard = [[
            InlineKeyboardButton(
                "💬 Chat Private dengan Bot", 
                url=f"https://t.me/{BOT_USERNAME}"
            )
        ]]
        
        await update.message.reply_text(
            f"⚠️ Perintah /start Tidak Tersedia di Grup\n\n"
            f"Perintah ini hanya dapat digunakan di private chat.\n\n"
            f"📌 Cara menggunakan:\n"
            f"1. Klik tombol di bawah\n"
            f"2. Tekan Start atau Mulai\n"
            f"3. Ketik /start di chat private\n\n"
            f"🔗 Link video tetap bisa diakses dari grup",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    elif command == "status":
        keyboard = [[
            InlineKeyboardButton(
                "💬 Chat Private dengan Bot", 
                url=f"https://t.me/{BOT_USERNAME}"
            )
        ]]
        
        await update.message.reply_text(
            f"⚠️ Perintah /status Tidak Tersedia di Grup\n\n"
            f"Perintah ini hanya dapat digunakan di private chat untuk melihat status pribadi Anda.\n\n"
            f"📌 Cara menggunakan:\n"
            f"1. Klik tombol di bawah\n"
            f"2. Tekan Start atau Mulai\n"
            f"3. Ketik /status di chat private\n\n"
            f"🔗 Untuk info VIP, ketik /vip di grup ini",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    elif command == "cari":
        keyboard = [[
            InlineKeyboardButton(
                "💬 Chat Private dengan Bot", 
                url=f"https://t.me/{BOT_USERNAME}"
            )
        ]]
        
        await update.message.reply_text(
            f"⚠️ Perintah /cari Tidak Tersedia di Grup\n\n"
            f"Perintah ini hanya dapat digunakan di private chat.\n\n"
            f"📌 Cara menggunakan:\n"
            f"1. Klik tombol di bawah\n"
            f"2. Ketik /cari di chat private\n\n"
            f"🔗 Untuk info VIP, ketik /vip di grup ini",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    else:
        await update.message.reply_text(
            f"❌ Perintah /{command} tidak dikenal.\n"
            f"Ketik /vip untuk info pembelian VIP."
        )

# ===================== BACKGROUND TASK =====================
async def check_expired_vip(context: ContextTypes.DEFAULT_TYPE):
    """Task untuk mengecek VIP yang expired dan hapus kode limit"""
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            
            # 1. Cek VIP Regular expired
            cursor.execute("SELECT user_id FROM users WHERE vip_until < datetime('now') AND vip_until IS NOT NULL")
            expired_regular = cursor.fetchall()
            cursor.execute("UPDATE users SET vip_until = NULL WHERE vip_until < datetime('now')")
            
            # 2. Cek VIP Limited expired
            cursor.execute("SELECT user_id FROM users WHERE vip_limited_until < datetime('now') AND vip_limited_until IS NOT NULL")
            expired_limited = cursor.fetchall()
            cursor.execute("UPDATE users SET vip_limited_until = NULL, vip_limited_views = 0 WHERE vip_limited_until < datetime('now')")
            
            # 3. BERSIHKAN KODE REDEEM EXPIRED & LIMIT (BARU)
            cursor.execute("""
                SELECT id, code FROM redeem_codes rc
                WHERE expires_at <= datetime('now')
                OR (SELECT COUNT(*) FROM redeem_history WHERE code_id = rc.id) >= rc.max_redeems
            """)
            to_delete = cursor.fetchall()
            
            for rc in to_delete:
                cursor.execute("DELETE FROM redeem_codes WHERE id = ?", (rc['id'],))
                fb_db = firebase_sync.get_db()
                if fb_db:
                    try: fb_db.collection('redeem_codes').document(rc['code']).delete()
                    except: pass
            
            if to_delete:
                logger.info(f"Otomatis menghapus {len(to_delete)} kode redeem (Expired/Limit)")
            
            conn.commit()
            
            # Kirim notifikasi ke user (opsional)
            for user in expired_regular:
                try: await context.bot.send_message(chat_id=user['user_id'], text="⚠️ Masa VIP Regular Anda telah berakhir!")
                except: pass
            for user in expired_limited:
                try: await context.bot.send_message(chat_id=user['user_id'], text="⚠️ Masa VIP Limited Anda telah berakhir!")
                except: pass
                
    except Exception as e:
        logger.error(f"Error in check_expired_vip: {e}")

# ===================== POST INIT =====================
async def post_init(application: Application):
    """Fungsi yang dijalankan setelah bot start"""
    logger.info("Bot started successfully")

# ===================== MAIN =====================
def main():
    """Main function"""
    init_database()
    
    application = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    
    # ==================== HANDLER UNTUK PRIVATE CHAT ====================
    application.add_handler(CommandHandler("start", start, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("status", status_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("vip", vip_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("cancel", cancel_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("privacy", privacy_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("search", search_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("hapus", hapus_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("db", db_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("cekuser", cekuser_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("addvip", addvip_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("tarikdata", tarikdata_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("sync_db", tarikdata_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("redeem", redeem_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("update", update_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("listgroup", listgroup_command, filters=filters.ChatType.PRIVATE))
    
    # Broadcast commands
    application.add_handler(CommandHandler("broadcast", broadcast_command, filters=filters.ChatType.PRIVATE))
    application.add_handler(CommandHandler("broadcast_status", broadcast_status_command, filters=filters.ChatType.PRIVATE))
    
    # ==================== HANDLER UNTUK GRUP ====================
    application.add_handler(MessageHandler(
        filters.COMMAND & (filters.ChatType.GROUPS),
        group_command_handler
    ))
    
    # ==================== HANDLER MEDIA ====================
    application.add_handler(MessageHandler(filters.ChatType.CHANNEL & (filters.VIDEO | filters.Document.VIDEO), handle_channel_post))
    application.add_handler(MessageHandler(filters.VIDEO & ~filters.ChatType.CHANNEL, handle_video))
    application.add_handler(MessageHandler(filters.Document.VIDEO & ~filters.ChatType.CHANNEL, handle_document))
    
    # ==================== HANDLER LAINNYA ====================
    application.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE, 
        handle_message
    ))
    
    application.add_handler(MessageHandler(
        filters.PHOTO & filters.ChatType.PRIVATE, 
        handle_photo
    ))
    
    # ==================== HANDLER CALLBACK KHUSUS SEARCH ====================
    application.add_handler(CallbackQueryHandler(search_result_callback, pattern="^search_result_"))
    application.add_handler(CallbackQueryHandler(search_page_callback, pattern="^sp_"))
    application.add_handler(CallbackQueryHandler(back_to_search_callback, pattern="^back_to_search$"))
    application.add_handler(CallbackQueryHandler(search_again_callback, pattern="^search_again$"))
    
    # ==================== HANDLER CALLBACK BROADCAST ====================
    application.add_handler(CallbackQueryHandler(broadcast_callback, pattern="^broadcast_"))
    
    # ==================== HANDLER CALLBACK UMUM ====================
    application.add_handler(CallbackQueryHandler(button_callback))
    
    # Job queue untuk cek expired VIP
    job_queue = application.job_queue
    if job_queue:
        job_queue.run_repeating(check_expired_vip, interval=3600, first=10)
        logger.info("Job queue started")
    
    print("="*70)
    print("[BOT] Bot Video sedang berjalan...")
    print(f"[INFO] Bot Username: @{BOT_USERNAME}")
    print(f"[ADMIN] Admin IDs: {ADMIN_IDS}")
    print(f"[DB] Database: {DATABASE_FILE}")
    print("="*70)
    print("[OK] METODE PEMBAYARAN: QRIS")
    print("="*70)
    print("[OK] VIP REGULAR (Full Akses):")
    print("   * Harga: Rp 1.000/hari")
    print("   * Paket: 7, 14, 30, 60, 90 hari")
    print("   * Akses: Tanpa batas")
    print("="*70)
    print("[OK] VIP LIMITED (Coba-coba):")
    print("   * Paket 1K: 1 hari - Rp 1.000 (2x lihat)")
    print("   * Paket 3K: 3 hari - Rp 3.000 (6x lihat)")
    print("="*70)
    print("[OK] FITUR BACKUP VIDEO:")
    print("   Format caption dengan tombol inline")
    print("="*70)
    print("[OK] FITUR BROADCAST:")
    print("   * Perintah: /broadcast")
    print("   * Support: Teks, Gambar, Video, Dokumen")
    print("   * Preview & Konfirmasi")
    print("   * Background process")
    print("   * Status: /broadcast_status")
    print("="*70)
    print("[OK] FITUR TAMBAHAN:")
    print("   * Pencarian dengan pagination")
    print("   * Manajemen video via tombol inline")
    print("   * Admin cek user & atur VIP")
    print("   * Statistik lengkap")
    print("="*70)
    
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == '__main__':
    main()