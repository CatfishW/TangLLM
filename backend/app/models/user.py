"""
User and UserSettings database models.
"""

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from ..database import Base


class User(Base):
    """User account model."""
    
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    email = Column(String(100), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(100), nullable=True)
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # Relationships
    settings = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")
    conversations = relationship("Conversation", back_populates="user", cascade="all, delete-orphan")


class UserSettings(Base):
    """User-specific settings for LLM configuration."""
    
    __tablename__ = "user_settings"
    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False)
    
    # LLM Configuration
    api_base_url = Column(String(500), nullable=True)
    model_id = Column(String(200), nullable=True)
    api_key = Column(String(500), nullable=True)  # Encrypted in production
    
    # Chat Settings
    system_prompt = Column(Text, nullable=True)
    temperature = Column(String(10), default="0.7")
    max_tokens = Column(Integer, default=4096)
    
    # UI Preferences
    theme = Column(String(20), default="dark")
    enable_voice = Column(Boolean, default=True)
    enable_sounds = Column(Boolean, default=True)
    show_thinking = Column(Boolean, default=True)
    thinking_mode = Column(String(20), default="auto")  # auto, fast, thinking
    
    # Relationships
    user = relationship("User", back_populates="settings")
