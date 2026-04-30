# -*- coding: utf-8 -*-
"""
============================================================
  firebase_sync.py
  Modul sinkronisasi data SQLite → Firebase Firestore
  Mode: DUAL-WRITE (SQLite tetap jalan, Firebase ikut update)
  
  Cara kerja:
  - Setiap kali bot menyimpan/update data di SQLite,
    fungsi di modul ini dipanggil untuk sync ke Firebase
  - Semua operasi Firebase berjalan secara ASYNC (non-blocking)
    sehingga TIDAK memperlambat bot
============================================================
"""

import logging
import asyncio
from datetime import datetime
from typing import Optional, Dict, Any

logger = logging.getLogger("FirebaseSync")

# ─── Inisialisasi Firebase (Singleton) ──────────────────────
_firebase_ready = False
_db = None

def init_firebase(key_path: str = "firebase-key.json") -> bool:
    """
    Inisialisasi koneksi Firebase.
    Dipanggil sekali saat bot startup.
    Return True jika berhasil, False jika gagal.
    """
    global _firebase_ready, _db
    
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
        
        # Hindari inisialisasi ganda
        if not firebase_admin._apps:
            cred = credentials.Certificate(key_path)
            firebase_admin.initialize_app(cred)
        
        _db = firestore.client()
        _firebase_ready = True
        logger.info("[Firebase] Koneksi Firebase berhasil!")
        return True
        
    except Exception as e:
        logger.warning(f"[Firebase] GAGAL konek Firebase: {e}")
        logger.warning("[Firebase] Bot tetap berjalan dengan SQLite saja.")
        _firebase_ready = False
        return False

def get_db():
    """Return Firestore client jika tersedia"""
    return _db if _firebase_ready else None

# ─── Helper internal ─────────────────────────────────────────
def _safe_sync(collection: str, doc_id: str, data: Dict[str, Any], merge: bool = True):
    """
    Internal: Sinkronisasi satu dokumen ke Firestore.
    Berjalan di thread terpisah agar tidak memblokir bot.
    """
    if not _firebase_ready or _db is None:
        return
    
    try:
        # Bersihkan nilai None agar tidak error di Firestore
        clean_data = {k: v for k, v in data.items() if v is not None}
        
        # Konversi string timestamp ke datetime object
        for key in ['uploaded_at', 'joined_at', 'vip_until', 'vip_limited_until',
                    'created_at', 'approved_at', 'completed_at']:
            if key in clean_data and isinstance(clean_data[key], str):
                try:
                    clean_data[key] = datetime.fromisoformat(clean_data[key])
                except (ValueError, TypeError):
                    pass
        
        clean_data['last_synced'] = datetime.now()
        
        _db.collection(collection).document(str(doc_id)).set(clean_data, merge=merge)
        
    except Exception as e:
        logger.error(f"[Firebase] Gagal sync {collection}/{doc_id}: {e}")

async def _async_sync(collection: str, doc_id: str, data: Dict[str, Any], merge: bool = True):
    """Jalankan sync di executor agar tidak memblokir event loop bot"""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _safe_sync, collection, doc_id, data, merge)

# ─── PUBLIC API: Dipanggil dari fsub.py ──────────────────────

# == USERS ==

def sync_user_create(user_id: int, username: str, first_name: str):
    """
    Sync saat user baru daftar (dipanggil setelah INSERT INTO users)
    """
    _safe_sync('users', str(user_id), {
        'user_id': user_id,
        'username': username,
        'first_name': first_name,
        'vip_until': None,
        'vip_limited_until': None,
        'vip_limited_views': 0,
        'vip_limited_total_views': 2,
        'is_admin': 0,
        'joined_at': datetime.now()
    })

def sync_user_vip_update(user_id: int, vip_until_iso: Optional[str],
                          vip_limited_until_iso: Optional[str] = None,
                          vip_limited_views: int = 0,
                          vip_limited_total_views: int = 2):
    """
    Sync saat status VIP user diupdate (approve payment, manual set VIP)
    """
    data = {
        'user_id': user_id,
        'vip_until': vip_until_iso,
        'vip_limited_until': vip_limited_until_iso,
        'vip_limited_views': vip_limited_views,
        'vip_limited_total_views': vip_limited_total_views,
    }
    _safe_sync('users', str(user_id), data, merge=True)

def sync_user_vip_clear(user_id: int, clear_regular: bool = False, clear_limited: bool = False):
    """
    Sync saat VIP user direset/dihapus oleh admin
    """
    data = {'user_id': user_id}
    if clear_regular:
        data['vip_until'] = None
    if clear_limited:
        data['vip_limited_until'] = None
        data['vip_limited_views'] = 0
    _safe_sync('users', str(user_id), data, merge=True)

def sync_user_limited_views(user_id: int, new_view_count: int):
    """
    Sync saat VIP Limited user menonton video (view count bertambah)
    """
    _safe_sync('users', str(user_id), {
        'user_id': user_id,
        'vip_limited_views': new_view_count
    }, merge=True)

# == VIDEOS ==

def sync_video_create(video_id: int, video_code: str, file_id: str,
                       caption: str, file_type: str, uploaded_by: int,
                       uploader_name: str, access_type: str = 'FREE',
                       bot_username: str = 'ShortTeamDl_bot'):
    """
    Sync saat video baru diupload (dipanggil setelah INSERT INTO videos)
    """
    _safe_sync('videos', video_code, {
        'id': video_id,
        'code': video_code,
        'file_id': file_id,
        'caption': caption,
        'file_type': file_type,
        'uploaded_by': uploaded_by,
        'uploader_name': uploader_name,
        'access_type': access_type,
        'view_count': 0,
        'uploaded_at': datetime.now(),
        'bot_link': f"https://t.me/{bot_username}?start={video_code}",
        'active_bot': bot_username
    })

def sync_video_update_ids(video_code: str, backup_message_id: Optional[int] = None,
                           log_message_id: Optional[int] = None):
    """
    Sync setelah backup/log message ID tersedia (dipanggil setelah UPDATE videos)
    """
    data = {}
    if backup_message_id is not None:
        data['backup_message_id'] = backup_message_id
    if log_message_id is not None:
        data['log_message_id'] = log_message_id
    if data:
        _safe_sync('videos', video_code, data, merge=True)

def sync_video_access_type(video_code: str, access_type: str):
    """
    Sync saat admin mengubah tipe akses video (FREE/VIP)
    """
    _safe_sync('videos', video_code, {
        'access_type': access_type
    }, merge=True)

def sync_video_view_count(video_code: str, new_count: int):
    """
    Sync saat view count video bertambah
    """
    _safe_sync('videos', video_code, {
        'view_count': new_count
    }, merge=True)

def sync_video_delete(video_code: str):
    """
    Hapus dokumen video dari Firebase saat video dihapus
    """
    if not _firebase_ready or _db is None:
        return
    try:
        _db.collection('videos').document(video_code).delete()
        logger.info(f"[Firebase] Video {video_code} dihapus dari Firebase")
    except Exception as e:
        logger.error(f"[Firebase] Gagal hapus video {video_code}: {e}")

# == PAYMENTS ==

def sync_payment_create(payment_id: int, user_id: int, amount: int,
                         days: int, payment_type: str, proof_file_id: str):
    """
    Sync saat user mengirim bukti pembayaran baru (status: PENDING)
    """
    _safe_sync('payments', str(payment_id), {
        'id': payment_id,
        'user_id': user_id,
        'amount': amount,
        'days': days,
        'payment_type': payment_type,
        'proof_file_id': proof_file_id,
        'status': 'PENDING',
        'created_at': datetime.now()
    })

def sync_payment_approved(payment_id: int, approved_by: int):
    """
    Sync saat admin menyetujui pembayaran
    """
    _safe_sync('payments', str(payment_id), {
        'status': 'APPROVED',
        'approved_by': approved_by,
        'approved_at': datetime.now()
    }, merge=True)

def sync_payment_rejected(payment_id: int, approved_by: int, reason: str):
    """
    Sync saat admin menolak pembayaran
    """
    _safe_sync('payments', str(payment_id), {
        'status': 'REJECTED',
        'approved_by': approved_by,
        'approved_at': datetime.now(),
        'rejected_reason': reason
    }, merge=True)

# == STATS ==

def sync_stat_view(video_id: int, video_code: str, user_id: int, metadata: Optional[str] = None):
    """
    Sync saat user menonton video (log aktivitas)
    Menggunakan auto-ID di subcollection stats
    """
    if not _firebase_ready or _db is None:
        return
    try:
        _db.collection('stats').add({
            'video_id': video_id,
            'video_code': video_code,
            'user_id': user_id,
            'action': 'VIEW',
            'metadata': metadata,
            'timestamp': datetime.now()
        })
    except Exception as e:
        logger.error(f"[Firebase] Gagal sync stat view: {e}")

# == REDEEM CODES ==

def sync_redeem_code_create(code: str, data: Dict[str, Any]):
    """
    Sync saat kode redeem baru dibuat
    """
    _safe_sync('redeem_codes', code, data)

def sync_redeem_code_delete(code: str):
    """
    Hapus kode redeem dari Firebase
    """
    if not _firebase_ready or _db is None:
        return
    try:
        _db.collection('redeem_codes').document(code).delete()
        logger.info(f"[Firebase] Kode redeem {code} dihapus")
    except Exception as e:
        logger.error(f"[Firebase] Gagal hapus kode redeem {code}: {e}")

# == SOURCE GROUPS ==

def sync_source_group_create(chat_id: int, data: Dict[str, Any]):
    """
    Sync saat grup sumber baru ditambahkan
    """
    _safe_sync('source_groups', str(chat_id), data)

def sync_source_group_delete(chat_id: int):
    """
    Hapus grup sumber dari Firebase
    """
    if not _firebase_ready or _db is None:
        return
    try:
        _db.collection('source_groups').document(str(chat_id)).delete()
    except Exception as e:
        logger.error(f"[Firebase] Gagal hapus source group {chat_id}: {e}")
