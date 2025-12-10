"""
File upload and serving routes.
"""

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models.user import User
from ..services.file_service import FileService
from ..utils.security import get_current_user


router = APIRouter(prefix="/api/files", tags=["Files"])

file_service = FileService()


@router.post("/upload")
async def upload_file(
    request: Request,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Upload an image or video file."""
    try:
        relative_path, media_type, metadata = await file_service.upload_file(
            file, 
            current_user.id
        )
        
        # Generate full URL
        base_url = str(request.base_url).rstrip("/")
        file_url = file_service.get_file_url(relative_path, base_url)
        
        return {
            "url": file_url,
            "relative_path": relative_path,
            "media_type": media_type,
            "metadata": metadata
        }
        
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )


@router.get("/{user_id}/{filename}")
async def get_file(user_id: int, filename: str):
    """Serve an uploaded file."""
    relative_path = f"{user_id}/{filename}"
    file_path = file_service.get_file_path(relative_path)
    
    if not file_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )
    
    return FileResponse(file_path)


@router.delete("/{user_id}/{filename}")
async def delete_file(
    user_id: int,
    filename: str,
    current_user: User = Depends(get_current_user)
):
    """Delete an uploaded file (only owner can delete)."""
    if current_user.id != user_id and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only delete your own files"
        )
    
    relative_path = f"{user_id}/{filename}"
    success = await file_service.delete_file(relative_path)
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )
    
    return {"message": "File deleted"}
