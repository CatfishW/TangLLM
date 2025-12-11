"""
Database connection and session management.
Uses SQLAlchemy async with aiosqlite.
"""

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from typing import AsyncGenerator

from .config import settings


# Create async engine
engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    future=True
)

from sqlalchemy import event
@event.listens_for(engine.sync_engine, "connect")
def set_sqlite_pragma(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    # WAL mode for better concurrency
    cursor.execute("PRAGMA journal_mode=WAL")
    # NORMAL synchronous is safe with WAL and faster than FULL
    cursor.execute("PRAGMA synchronous=NORMAL")
    # 32MB cache size for better read performance
    cursor.execute("PRAGMA cache_size=-32000")
    # Store temp tables in memory
    cursor.execute("PRAGMA temp_store=MEMORY")
    # Memory-map up to 512MB for faster reads
    cursor.execute("PRAGMA mmap_size=536870912")
    # Busy timeout - wait up to 5 seconds
    cursor.execute("PRAGMA busy_timeout=5000")
    # Enable query result caching
    cursor.execute("PRAGMA cache_spill=false")
    cursor.close()


# Create async session factory
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False
)


class Base(DeclarativeBase):
    """Base class for all database models."""
    pass


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Dependency to get database session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def init_db():
    """Initialize database tables."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db():
    """Close database connections."""
    await engine.dispose()
