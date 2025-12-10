"""
Authentication service with user management.
"""

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional

from ..models.user import User, UserSettings
from ..schemas.user import UserRegister, UserLogin, Token
from ..utils.security import (
    get_password_hash, 
    verify_password, 
    create_access_token, 
    create_refresh_token,
    decode_token
)
from ..config import settings


class AuthService:
    """Service for authentication and user management."""
    
    def __init__(self, db: AsyncSession):
        self.db = db
    
    async def register(self, user_data: UserRegister) -> User:
        """Register a new user."""
        # Check if username exists
        result = await self.db.execute(
            select(User).filter(User.username == user_data.username)
        )
        if result.scalar_one_or_none():
            raise ValueError("Username already registered")
        
        # Check if email exists
        result = await self.db.execute(
            select(User).filter(User.email == user_data.email)
        )
        if result.scalar_one_or_none():
            raise ValueError("Email already registered")
        
        # Create user
        user = User(
            username=user_data.username,
            email=user_data.email,
            hashed_password=get_password_hash(user_data.password),
            full_name=user_data.full_name
        )
        self.db.add(user)
        await self.db.flush()
        
        # Create default settings
        user_settings = UserSettings(
            user_id=user.id,
            api_base_url=settings.DEFAULT_API_BASE,
            model_id=settings.DEFAULT_MODEL_ID
        )
        self.db.add(user_settings)
        
        await self.db.commit()
        await self.db.refresh(user)
        
        return user
    
    async def authenticate(self, login_data: UserLogin) -> Optional[User]:
        """Authenticate a user by username and password."""
        result = await self.db.execute(
            select(User).filter(User.username == login_data.username)
        )
        user = result.scalar_one_or_none()
        
        if not user:
            return None
        
        if not verify_password(login_data.password, user.hashed_password):
            return None
        
        return user
    
    def create_tokens(self, user: User) -> Token:
        """Create access and refresh tokens for a user."""
        token_data = {"sub": str(user.id), "username": user.username}
        
        access_token = create_access_token(token_data)
        refresh_token = create_refresh_token(token_data)
        
        return Token(
            access_token=access_token,
            refresh_token=refresh_token
        )
    
    async def refresh_tokens(self, refresh_token: str) -> Token:
        """Refresh access token using refresh token."""
        token_data = decode_token(refresh_token)
        
        result = await self.db.execute(
            select(User).filter(User.id == token_data.user_id)
        )
        user = result.scalar_one_or_none()
        
        if not user or not user.is_active:
            raise ValueError("Invalid refresh token")
        
        return self.create_tokens(user)
    
    async def change_password(self, user: User, current_password: str, new_password: str) -> bool:
        """Change user password."""
        if not verify_password(current_password, user.hashed_password):
            return False
        
        user.hashed_password = get_password_hash(new_password)
        await self.db.commit()
        
        return True
    
    async def get_user_by_id(self, user_id: int) -> Optional[User]:
        """Get user by ID."""
        result = await self.db.execute(
            select(User).filter(User.id == user_id)
        )
        return result.scalar_one_or_none()
    
    async def get_user_settings(self, user_id: int) -> Optional[UserSettings]:
        """Get user settings."""
        result = await self.db.execute(
            select(UserSettings).filter(UserSettings.user_id == user_id)
        )
        return result.scalar_one_or_none()
    
    async def update_user_settings(self, user_id: int, updates: dict) -> UserSettings:
        """Update user settings."""
        result = await self.db.execute(
            select(UserSettings).filter(UserSettings.user_id == user_id)
        )
        user_settings = result.scalar_one_or_none()
        
        if not user_settings:
            # Create settings if they don't exist
            user_settings = UserSettings(user_id=user_id)
            self.db.add(user_settings)
        
        for key, value in updates.items():
            if hasattr(user_settings, key) and value is not None:
                setattr(user_settings, key, value)
        
        await self.db.commit()
        await self.db.refresh(user_settings)
        
        return user_settings
