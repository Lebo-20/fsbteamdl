# -*- coding: utf-8 -*-
"""
============================================================
  SCRIPT MIGRASI: SQLite → Firebase Firestore
  Bot: ShortTeamDl (@ShortTeamDl_bot)
  File DB: bot_database.db
  Firebase Project: botfsub-85a55
============================================================

Cara Pakai:
  1. Pastikan firebase-admin sudah terinstall: pip install firebase-admin
  2. Pastikan file firebase-key.json ada di folder yang sama
  3. Jalankan: python migrate_to_firebase.py
"""

import sqlite3
import firebase_admin
from firebase_admin import credentials, firestore
import logging
from datetime import datetime

# ─── Setup Logging ───────────────────────────────────────────
logging.basicConfig(
    format='%(asctime)s [%(levelname)s] %(message)s',
    level=logging.INFO,
    handlers=[
        logging.StreamHandler(open(1, 'w', encoding='utf-8', closefd=False)),
        logging.FileHandler('migrate_log.txt', encoding='utf-8')
    ]
)
logger = logging.getLogger("MigrasiFirebase")

# ─── Konfigurasi ─────────────────────────────────────────────
DATABASE_FILE = "bot_database.db"
FIREBASE_KEY   = "firebase-key.json"

# ─── Inisialisasi Firebase ───────────────────────────────────
logger.info("[FIREBASE] Menghubungkan ke Firebase...")
cred = credentials.Certificate(FIREBASE_KEY)
firebase_admin.initialize_app(cred)
db_firebase = firestore.client()
logger.info("[FIREBASE] Firebase berhasil terhubung!")

# ─── Koneksi SQLite ──────────────────────────────────────────
db_sqlite = sqlite3.connect(DATABASE_FILE)
db_sqlite.row_factory = sqlite3.Row
cursor = db_sqlite.cursor()

# ─────────────────────────────────────────────────────────────
#  HELPER: Konversi Row SQLite → Dict bersih
# ─────────────────────────────────────────────────────────────
def row_to_dict(row):
    """Konversi sqlite3.Row ke dict, hapus nilai None agar Firestore bersih"""
    result = {}
    for key in row.keys():
        val = row[key]
        # Konversi string timestamp ke datetime object agar terbaca rapi di Firebase
        if val and isinstance(val, str) and ('T' in val or '-' in val):
            try:
                result[key] = datetime.fromisoformat(val)
                continue
            except ValueError:
                pass
        result[key] = val
    return result

# ─────────────────────────────────────────────────────────────
#  1. MIGRASI TABEL: users
# ─────────────────────────────────────────────────────────────
def migrate_users():
    logger.info("[USERS] Mulai migrasi tabel users...")
    cursor.execute("SELECT * FROM users")
    rows = cursor.fetchall()
    
    batch = db_firebase.batch()
    count = 0
    
    for row in rows:
        data = row_to_dict(row)
        user_id = str(data['user_id'])
        
        # Tambah field tambahan agar mudah dibaca di Firebase Console
        data['migrated_at'] = firestore.SERVER_TIMESTAMP
        
        doc_ref = db_firebase.collection('users').document(user_id)
        batch.set(doc_ref, data, merge=True)
        count += 1
        
        # Firestore batch limit = 500 operasi
        if count % 499 == 0:
            batch.commit()
            batch = db_firebase.batch()
            logger.info(f"   Batch dikirim ({count} data)")
    
    batch.commit()
    logger.info(f"[USERS] SELESAI: {count} user berhasil dimigrasi!")

# ─────────────────────────────────────────────────────────────
#  2. MIGRASI TABEL: videos
# ─────────────────────────────────────────────────────────────
def migrate_videos():
    logger.info("[VIDEOS] Mulai migrasi tabel videos...")
    cursor.execute("SELECT * FROM videos")
    rows = cursor.fetchall()
    
    batch = db_firebase.batch()
    count = 0
    
    for row in rows:
        data = row_to_dict(row)
        video_code = data.get('code', str(data.get('id')))
        
        # Tambah deep link bot secara otomatis
        data['bot_link'] = f"https://t.me/ShortTeamDl_bot?start={video_code}"
        data['migrated_at'] = firestore.SERVER_TIMESTAMP
        
        doc_ref = db_firebase.collection('videos').document(video_code)
        batch.set(doc_ref, data, merge=True)
        count += 1
        
        if count % 499 == 0:
            batch.commit()
            batch = db_firebase.batch()
            logger.info(f"   Batch dikirim ({count} data)")
    
    batch.commit()
    logger.info(f"[VIDEOS] SELESAI: {count} video berhasil dimigrasi!")

# ─────────────────────────────────────────────────────────────
#  3. MIGRASI TABEL: payments
# ─────────────────────────────────────────────────────────────
def migrate_payments():
    logger.info("[PAYMENTS] Mulai migrasi tabel payments...")
    cursor.execute("SELECT * FROM payments")
    rows = cursor.fetchall()
    
    batch = db_firebase.batch()
    count = 0
    
    for row in rows:
        data = row_to_dict(row)
        payment_id = str(data['id'])
        
        data['migrated_at'] = firestore.SERVER_TIMESTAMP
        
        doc_ref = db_firebase.collection('payments').document(payment_id)
        batch.set(doc_ref, data, merge=True)
        count += 1
        
        if count % 499 == 0:
            batch.commit()
            batch = db_firebase.batch()
            logger.info(f"   Batch dikirim ({count} data)")
    
    batch.commit()
    logger.info(f"[PAYMENTS] SELESAI: {count} pembayaran berhasil dimigrasi!")

# ─────────────────────────────────────────────────────────────
#  4. MIGRASI TABEL: broadcasts
# ─────────────────────────────────────────────────────────────
def migrate_broadcasts():
    logger.info("[BROADCASTS] Mulai migrasi tabel broadcasts...")
    cursor.execute("SELECT * FROM broadcasts")
    rows = cursor.fetchall()
    
    batch = db_firebase.batch()
    count = 0
    
    for row in rows:
        data = row_to_dict(row)
        broadcast_id = str(data['id'])
        
        data['migrated_at'] = firestore.SERVER_TIMESTAMP
        
        doc_ref = db_firebase.collection('broadcasts').document(broadcast_id)
        batch.set(doc_ref, data, merge=True)
        count += 1
        
        if count % 499 == 0:
            batch.commit()
            batch = db_firebase.batch()
    
    batch.commit()
    logger.info(f"[BROADCASTS] SELESAI: {count} broadcast berhasil dimigrasi!")

# ─────────────────────────────────────────────────────────────
#  5. MIGRASI TABEL: stats
# ─────────────────────────────────────────────────────────────
def migrate_stats():
    logger.info("[STATS] Mulai migrasi tabel stats...")
    cursor.execute("SELECT * FROM stats")
    rows = cursor.fetchall()
    
    batch = db_firebase.batch()
    count = 0
    
    for row in rows:
        data = row_to_dict(row)
        stat_id = str(data['id'])
        
        data['migrated_at'] = firestore.SERVER_TIMESTAMP
        
        doc_ref = db_firebase.collection('stats').document(stat_id)
        batch.set(doc_ref, data, merge=True)
        count += 1
        
        if count % 499 == 0:
            batch.commit()
            batch = db_firebase.batch()
            logger.info(f"   Batch dikirim ({count} data)")
    
    batch.commit()
    logger.info(f"[STATS] SELESAI: {count} stat berhasil dimigrasi!")

# ─────────────────────────────────────────────────────────────
#  JALANKAN SEMUA MIGRASI
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info("=" * 55)
    logger.info("MULAI MIGRASI: SQLite ke Firebase Firestore")
    logger.info("=" * 55)
    start = datetime.now()
    
    try:
        migrate_users()
        migrate_videos()
        migrate_payments()
        migrate_broadcasts()
        migrate_stats()
    except Exception as e:
        logger.error(f"GAGAL saat migrasi: {e}")
        raise
    finally:
        db_sqlite.close()
    
    selesai = datetime.now()
    durasi = (selesai - start).total_seconds()
    
    logger.info("=" * 55)
    logger.info(f"MIGRASI SELESAI dalam {durasi:.1f} detik!")
    logger.info("Cek data di: https://console.firebase.google.com/")
    logger.info("Project: botfsub-85a55")
    logger.info("=" * 55)
