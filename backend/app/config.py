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
    # Use absolute path to ensure DB is found regardless of working directory
    # resolved relative to this config file (backend/app/config.py -> backend/tangllm.db)
    _BASE_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    DATABASE_URL: str = f"sqlite+aiosqlite:///{os.path.join(_BASE_DIR, 'tangllm.db')}"
    
    # JWT Authentication
    SECRET_KEY: str = Field(default_factory=get_or_create_secret_key)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 hours
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    
    # Default LLM Settings
    DEFAULT_API_BASE: str = "https://game.agaii.org/mllm/v1"
    DEFAULT_MODEL_ID: str = "Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"
    
    # File Upload
    UPLOAD_DIR: str = os.path.join(_BASE_DIR, "uploads")
    MAX_UPLOAD_SIZE: int = 100 * 1024 * 1024  # 100MB for videos (will be compressed)
    ALLOWED_IMAGE_TYPES: list = ["image/jpeg", "image/png", "image/gif", "image/webp"]
    ALLOWED_VIDEO_TYPES: list = ["video/mp4", "video/webm", "video/quicktime"]
    
    # Text-to-Image API
    T2I_API_BASE: str = "https://game.agaii.org/t2i"
    T2I_DEFAULT_WIDTH: int = 1024
    T2I_DEFAULT_HEIGHT: int = 1024
    T2I_DEFAULT_STEPS: int = 9
    
    # Text-to-Speech API
    TTS_API_BASE: str = "https://game.agaii.org/tts2"
    TTS_DEFAULT_VOICE: str = "examples/prompt1.wav"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 6666
    
    class Config:
        env_file = ".env"
        case_sensitive = True


# Global settings instance
settings = Settings()
