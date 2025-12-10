"""
User settings routes.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..schemas.user import UserSettingsResponse, UserSettingsUpdate
from ..models.user import User
from ..services.auth_service import AuthService
from ..utils.security import get_current_user


router = APIRouter(prefix="/api/settings", tags=["Settings"])


@router.get("", response_model=UserSettingsResponse)
async def get_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get current user settings."""
    auth_service = AuthService(db)
    settings = await auth_service.get_user_settings(current_user.id)
    
    if not settings:
        # Create default settings
        settings = await auth_service.update_user_settings(current_user.id, {})
    
    return settings


@router.put("", response_model=UserSettingsResponse)
async def update_settings(
    updates: UserSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update user settings."""
    auth_service = AuthService(db)
    
    settings = await auth_service.update_user_settings(
        current_user.id,
        updates.model_dump(exclude_unset=True)
    )
    
    return settings


@router.post("/reset")
async def reset_settings(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Reset settings to defaults."""
    from ..config import settings as app_settings
    
    auth_service = AuthService(db)
    
    default_settings = {
        "api_base_url": app_settings.DEFAULT_API_BASE,
        "model_id": app_settings.DEFAULT_MODEL_ID,
        "api_key": None,
        "system_prompt": None,
        "temperature": "0.7",
        "max_tokens": 4096,
        "theme": "dark",
        "enable_voice": True,
        "enable_sounds": True
    }
    
    settings = await auth_service.update_user_settings(
        current_user.id,
        default_settings
    )
    
    return {"message": "Settings reset to defaults", "settings": settings}
