"""
File service for handling uploads.
"""

import os
import uuid
import aiofiles
from pathlib import Path
from typing import Optional, Tuple
from fastapi import UploadFile
from PIL import Image
import io

from ..config import settings


class FileService:
    """Service for file upload and management."""
    
    def __init__(self):
        self.upload_dir = Path(settings.UPLOAD_DIR)
        self.upload_dir.mkdir(parents=True, exist_ok=True)
    
    def _generate_filename(self, original_filename: str) -> str:
        """Generate a unique filename."""
        ext = Path(original_filename).suffix.lower()
        return f"{uuid.uuid4().hex}{ext}"
    
    def _get_file_type(self, content_type: str) -> Optional[str]:
        """Determine if file is image or video."""
        if content_type in settings.ALLOWED_IMAGE_TYPES:
            return "image"
        elif content_type in settings.ALLOWED_VIDEO_TYPES:
            return "video"
        return None
    
    async def upload_file(self, file: UploadFile, user_id: int) -> Tuple[str, str, dict]:
        """
        Upload a file and return (filename, media_type, metadata).
        """
        # Validate file type
        file_type = self._get_file_type(file.content_type)
        if not file_type:
            raise ValueError(f"Unsupported file type: {file.content_type}")
        
        # Check file size
        content = await file.read()
        if len(content) > settings.MAX_UPLOAD_SIZE:
            raise ValueError(f"File too large. Maximum size: {settings.MAX_UPLOAD_SIZE / (1024*1024)}MB")
        
        # Generate unique filename
        filename = self._generate_filename(file.filename)
        
        # Create user-specific directory
        user_dir = self.upload_dir / str(user_id)
        user_dir.mkdir(parents=True, exist_ok=True)
        
        # Save file
        file_path = user_dir / filename
        async with aiofiles.open(file_path, "wb") as f:
            await f.write(content)
        
        # Generate metadata
        metadata = {
            "original_filename": file.filename,
            "content_type": file.content_type,
            "size": len(content)
        }
        
        # Get image dimensions if image
        if file_type == "image":
            try:
                img = Image.open(io.BytesIO(content))
                metadata["width"] = img.width
                metadata["height"] = img.height
            except Exception:
                pass
        
        return f"{user_id}/{filename}", file_type, metadata
    
    def get_file_path(self, relative_path: str) -> Optional[Path]:
        """Get the full path to a file."""
        file_path = self.upload_dir / relative_path
        if file_path.exists() and file_path.is_file():
            return file_path
        return None
    
    async def delete_file(self, relative_path: str) -> bool:
        """Delete a file."""
        file_path = self.upload_dir / relative_path
        if file_path.exists():
            os.remove(file_path)
            return True
        return False
    
    def get_file_url(self, relative_path: str, base_url: str) -> str:
        """Generate the full URL for a file."""
        return f"{base_url}/api/files/{relative_path}"
