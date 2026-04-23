import sqlite3
import os

dbs = ['bot_database.db', 'bot.db', 'fsub_bot.db']

for db in dbs:
    if os.path.exists(db):
        try:
            conn = sqlite3.connect(db)
            cursor = conn.cursor()
            cursor.execute("PRAGMA table_info(stats)")
            columns = [col[1] for col in cursor.fetchall()]
            if columns and 'metadata' not in columns:
                cursor.execute("ALTER TABLE stats ADD COLUMN metadata TEXT")
                conn.commit()
                print(f"Added metadata to stats in {db}")
            elif not columns:
                print(f"No stats table in {db}")
            else:
                print(f"metadata already exists in stats in {db}")
            conn.close()
        except Exception as e:
            print(f"Error processing {db}: {e}")
