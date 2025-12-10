import asyncio
import os
import sys

# Add the current directory to sys.path so we can import app
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.database import AsyncSessionLocal, engine
from app.models.conversation import Conversation
from app.models.user import User
from sqlalchemy import select

async def debug_db():
    print(f"Database URL: {engine.url}")
    
    async with AsyncSessionLocal() as session:
        print("\n--- USERS ---")
        result = await session.execute(select(User))
        users = result.scalars().all()
        if not users:
            print("No users found.")
        for u in users:
            print(f"ID: {u.id} | Username: {u.username} | Active: {u.is_active}")
            
        print("\n--- CONVERSATIONS ---")
        result = await session.execute(select(Conversation))
        convs = result.scalars().all()
        if not convs:
            print("No conversations found.")
        for c in convs:
            print(f"ID: {c.id} | UserID: {c.user_id} | Title: {c.title}")

    await engine.dispose()

if __name__ == "__main__":
    if os.name == 'nt':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(debug_db())
