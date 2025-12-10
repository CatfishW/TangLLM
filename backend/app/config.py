"""
Configuration settings for TangLLM backend.
Uses pydantic-settings for environment variable support.
"""

from pydantic_settings import BaseSettings
from typing import Optional
import secrets


class Settings(BaseSettings):
    """Application configuration settings."""
    
    # Application
    APP_NAME: str = "TangLLM"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = True
    
    # Database
    DATABASE_URL: str = "sqlite+aiosqlite:///./tangllm.db"
    
    # JWT Authentication
    SECRET_KEY: str = secrets.token_urlsafe(32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # Default LLM Settings
    DEFAULT_API_BASE: str = "https://game.agaii.org/mllm/v1"
    DEFAULT_MODEL_ID: str = "Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"
    
    # File Upload
    UPLOAD_DIR: str = "uploads"
    MAX_UPLOAD_SIZE: int = 100 * 1024 * 1024  # 100MB
    ALLOWED_IMAGE_TYPES: list = ["image/jpeg", "image/png", "image/gif", "image/webp"]
    ALLOWED_VIDEO_TYPES: list = ["video/mp4", "video/webm", "video/quicktime"]
    
    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    
    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()
