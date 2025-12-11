#!/usr/bin/env python3
"""
Database Migration Script
Adds missing columns to user_settings table
"""

import sqlite3
import os

# Database path - adjust if needed
DB_PATH = os.path.join(os.path.dirname(__file__), "uploads", "tangllm.db")

def get_existing_columns(cursor, table_name):
    """Get list of existing column names in a table."""
    cursor.execute(f"PRAGMA table_info({table_name})")
    return [row[1] for row in cursor.fetchall()]

def migrate():
    print(f"Connecting to database: {DB_PATH}")
    
    if not os.path.exists(DB_PATH):
        print(f"Database not found at {DB_PATH}")
        print("The database will be created when you start the application.")
        return
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    try:
        # Check if user_settings table exists
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'")
        if not cursor.fetchone():
            print("Table 'user_settings' does not exist. It will be created when the app starts.")
            return
        
        # Get existing columns
        existing_columns = get_existing_columns(cursor, "user_settings")
        print(f"Existing columns: {existing_columns}")
        
        # Columns to add
        migrations = [
            ("show_thinking", "BOOLEAN DEFAULT 1"),
            ("thinking_mode", "VARCHAR(20) DEFAULT 'auto'"),
        ]
        
        for column_name, column_def in migrations:
            if column_name not in existing_columns:
                print(f"Adding column: {column_name}")
                cursor.execute(f"ALTER TABLE user_settings ADD COLUMN {column_name} {column_def}")
                print(f"  ✓ Added {column_name}")
            else:
                print(f"  ✓ Column {column_name} already exists")
        
        # Create indexes for better performance
        indexes = [
            ("ix_messages_conversation_created", "messages", "conversation_id, created_at"),
            ("ix_conversations_user_updated", "conversations", "user_id, updated_at DESC"),
            ("ix_user_settings_user_id", "user_settings", "user_id"),
        ]
        
        print("\n📊 Checking indexes...")
        for idx_name, table_name, columns in indexes:
            cursor.execute(f"SELECT name FROM sqlite_master WHERE type='index' AND name='{idx_name}'")
            if not cursor.fetchone():
                try:
                    cursor.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table_name} ({columns})")
                    print(f"  ✓ Created index {idx_name}")
                except Exception as e:
                    print(f"  ⚠ Could not create {idx_name}: {e}")
            else:
                print(f"  ✓ Index {idx_name} already exists")
        
        # Apply SQLite performance optimizations
        print("\n⚡ Applying SQLite optimizations...")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-32000")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA mmap_size=536870912")
        cursor.execute("PRAGMA optimize")
        print("  ✓ WAL mode, 32MB cache, mmap enabled")
        
        conn.commit()
        print("\n✅ Migration completed successfully!")
        
    except Exception as e:
        print(f"\n❌ Migration failed: {e}")
        conn.rollback()
        raise
    finally:
        conn.close()

if __name__ == "__main__":
    migrate()
