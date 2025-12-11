"""
User-related Pydantic schemas.
"""

from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime


# ============= Auth Schemas =============

class UserRegister(BaseModel):
    """Schema for user registration."""
    username: str = Field(..., min_length=3, max_length=50, pattern=r"^[a-zA-Z0-9_]+$")
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=100)
    full_name: Optional[str] = Field(None, max_length=100)


class UserLogin(BaseModel):
    """Schema for user login."""
    username: str
    password: str


class Token(BaseModel):
    """JWT token response."""
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    """Token payload data."""
    user_id: Optional[int] = None
    username: Optional[str] = None


class PasswordChange(BaseModel):
    """Schema for password change."""
    current_password: str
    new_password: str = Field(..., min_length=6, max_length=100)


# ============= User Response Schemas =============

class UserBase(BaseModel):
    """Base user schema."""
    username: str
    email: EmailStr
    full_name: Optional[str] = None


class UserResponse(UserBase):
    """User response schema."""
    id: int
    is_active: bool
    is_admin: bool
    created_at: datetime
    
    class Config:
        from_attributes = True


class UserWithSettings(UserResponse):
    """User response with settings."""
    settings: Optional["UserSettingsResponse"] = None


# ============= Settings Schemas =============

class UserSettingsBase(BaseModel):
    """Base settings schema."""
    model_config = {"protected_namespaces": ()}
    
    api_base_url: Optional[str] = None
    model_id: Optional[str] = None
    api_key: Optional[str] = None
    system_prompt: Optional[str] = None
    temperature: str = "0.7"
    max_tokens: int = 4096
    theme: str = "dark"
    enable_voice: bool = True
    enable_sounds: bool = True
    show_thinking: bool = True
    thinking_mode: str = "auto"  # auto, fast, thinking


class UserSettingsUpdate(UserSettingsBase):
    """Schema for updating settings."""
    pass


class UserSettingsResponse(UserSettingsBase):
    """Settings response schema."""
    id: int
    user_id: int
    
    class Config:
        from_attributes = True


# Update forward reference
UserWithSettings.model_rebuild()
