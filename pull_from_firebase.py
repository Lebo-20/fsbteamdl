# -*- coding: utf-8 -*-
"""
============================================================
  pull_from_firebase.py
  Script untuk menarik data dari Firebase Firestore ke SQLite
  Gunakan ini jika VPS baru atau database lokal kosong.
============================================================
"""

import sqlite3
import firebase_admin
from firebase_admin import credentials, firestore
import logging
from datetime import datetime

# Setup Logging
logging.basicConfig(format='%(asctime)s [%(levelname)s] %(message)s', level=logging.INFO)
logger = logging.getLogger("PullFirebase")

# Konfigurasi
DATABASE_FILE = "bot_database.db"
FIREBASE_KEY   = "firebase-key.json"

# Inisialisasi Firebase
logger.info("[FIREBASE] Menghubungkan ke Firebase...")
cred = credentials.Certificate(FIREBASE_KEY)
firebase_admin.initialize_app(cred)
db_fb = firestore.client()
logger.info("[FIREBASE] Berhasil terhubung!")

# Koneksi SQLite
db_sq = sqlite3.connect(DATABASE_FILE)
db_sq.row_factory = sqlite3.Row
cursor = db_sq.cursor()

def pull_collection(collection_name, table_name):
    logger.info(f"[{collection_name.upper()}] Menarik data dari Firebase...")
    docs = db_fb.collection(collection_name).stream()
    
    count = 0
    for doc in docs:
        data = doc.to_dict()
        
        # Hilangkan field yang tidak ada di SQLite jika perlu (migrated_at, last_synced)
        keys_to_remove = ['migrated_at', 'last_synced', 'bot_link', 'active_bot']
        for key in keys_to_remove:
            data.pop(key, None)
            
        # Bersihkan data (convert timestamp Firestore ke ISO string untuk SQLite)
        for k, v in data.items():
            if hasattr(v, 'isoformat'): # Jika objek datetime/Timestamp
                data[k] = v.isoformat()
        
        # Buat query INSERT OR REPLACE secara dinamis
        columns = ', '.join(data.keys())
        placeholders = ', '.join(['?'] * len(data))
        sql = f"INSERT OR REPLACE INTO {table_name} ({columns}) VALUES ({placeholders})"
        
        try:
            cursor.execute(sql, list(data.values()))
            count += 1
        except Exception as e:
            logger.error(f"  Gagal insert {collection_name} ID {doc.id}: {e}")
    
    db_sq.commit()
    logger.info(f"[✅] Berhasil menarik {count} data ke tabel {table_name}")

if __name__ == "__main__":
    print("="*60)
    print("      SYNC DOWNLOAD: FIREBASE -> SQLITE LOKAL")
    print("="*60)
    
    try:
        # Tarik tabel utama
        pull_collection('users', 'users')
        pull_collection('videos', 'videos')
        pull_collection('payments', 'payments')
        
        print("\n" + "="*60)
        print("✅ SEMUA DATA BERHASIL DISINKRONKAN!")
        print("Sekarang database lokal Anda sudah berisi data dari Firebase.")
        print("Silakan restart bot Anda.")
        print("="*60)
    except Exception as e:
        print(f"\n[❌] ERROR FATAL: {e}")
    finally:
        db_sq.close()
