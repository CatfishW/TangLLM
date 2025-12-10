"""
Configuration settings for TangLLM backend.
Uses pydantic-settings for environment variable support.
"""

from pydantic_settings import BaseSettings
from pydantic import Field
from typing import Optional
import secrets
import os


def get_or_create_secret_key():
    """Get secret key from file or generate a new one."""
    secret_file = ".secret_key"
    if os.path.exists(secret_file):
        try:
            with open(secret_file, "r") as f:
                return f.read().strip()
        except Exception:
            pass
            
    # Generate new key
    key = secrets.token_urlsafe(32)
    try:
        with open(secret_file, "w") as f:
            f.write(key)
    except Exception:
        pass  # If we can't write (e.g. read-only fs), just return the key
        
    return key


class Settings(BaseSettings):
    """Application configuration settings."""
    
    # Application
    APP_NAME: str = "TangLLM"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True
    
    # Database
    DATABASE_URL: str = "sqlite+aiosqlite:///./tangllm.db"
    
    # JWT Authentication
    SECRET_KEY: str = Field(default_factory=get_or_create_secret_key)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # Default LLM Settings
    DEFAULT_API_BASE: str = "https://game.agaii.org/mllm/v1"
    DEFAULT_MODEL_ID: str = "Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"
    
    # File Upload
    UPLOAD_DIR: str = "uploads"
    MAX_UPLOAD_SIZE: int = 50 * 512 * 512  # 50MB
    ALLOWED_IMAGE_TYPES: list = ["image/jpeg", "image/png", "image/gif", "image/webp"]
    ALLOWED_VIDEO_TYPES: list = ["video/mp4", "video/webm", "video/quicktime"]
    
    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 6666
    
    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()
