"""
File service for handling uploads.
"""

import os
import uuid
import aiofiles
import subprocess
import tempfile
import shutil
from pathlib import Path
from typing import Optional, Tuple
from fastapi import UploadFile
from PIL import Image
import io

from ..config import settings


# Video compression threshold (10MB)
VIDEO_COMPRESSION_THRESHOLD = 10 * 1024 * 1024  # 10MB
# Target video size after compression (8MB)
VIDEO_TARGET_SIZE = 8 * 1024 * 1024  # 8MB


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
    
    def _check_ffmpeg_available(self) -> bool:
        """Check if ffmpeg is available."""
        try:
            result = subprocess.run(
                ["ffmpeg", "-version"],
                capture_output=True,
                timeout=5
            )
            return result.returncode == 0
        except Exception:
            return False
    
    def _compress_video(self, input_path: str, output_path: str, target_size_mb: float = 8) -> bool:
        """
        Compress video using ffmpeg.
        Uses CRF (Constant Rate Factor) for quality-based encoding.
        """
        try:
            # Get video duration first
            probe_cmd = [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                input_path
            ]
            result = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30)
            duration = float(result.stdout.strip()) if result.stdout.strip() else 10
            
            # Calculate target bitrate (bits per second)
            # Target size in bits / duration = target bitrate
            target_bitrate = int((target_size_mb * 8 * 1024 * 1024) / duration)
            # Cap at reasonable range (200kbps - 2Mbps)
            target_bitrate = max(200000, min(target_bitrate, 2000000))
            
            # Compress with ffmpeg
            compress_cmd = [
                "ffmpeg",
                "-i", input_path,
                "-c:v", "libx264",
                "-preset", "fast",
                "-b:v", f"{target_bitrate}",
                "-maxrate", f"{int(target_bitrate * 1.5)}",
                "-bufsize", f"{int(target_bitrate * 2)}",
                "-vf", "scale='min(1280,iw)':'-2'",  # Max 1280px width, maintain aspect ratio
                "-c:a", "aac",
                "-b:a", "128k",
                "-y",  # Overwrite output
                output_path
            ]
            
            result = subprocess.run(compress_cmd, capture_output=True, timeout=300)
            return result.returncode == 0
            
        except Exception as e:
            print(f"Video compression failed: {e}")
            return False
    
    async def upload_file(self, file: UploadFile, user_id: int) -> Tuple[str, str, dict]:
        """
        Upload a file and return (filename, media_type, metadata).
        Videos exceeding threshold will be automatically compressed.
        """
        # Validate file type
        file_type = self._get_file_type(file.content_type)
        if not file_type:
            raise ValueError(f"Unsupported file type: {file.content_type}")
        
        # Read file content
        content = await file.read()
        original_size = len(content)
        
        # Check if file exceeds max upload size (after potential compression)
        if original_size > settings.MAX_UPLOAD_SIZE and file_type != "video":
            raise ValueError(f"File too large. Maximum size: {settings.MAX_UPLOAD_SIZE / (1024*1024):.1f}MB")
        
        # Generate unique filename
        filename = self._generate_filename(file.filename)
        
        # Create user-specific directory
        user_dir = self.upload_dir / str(user_id)
        user_dir.mkdir(parents=True, exist_ok=True)
        
        # File path
        file_path = user_dir / filename
        compressed = False
        
        # Check if video needs compression
        if file_type == "video" and original_size > VIDEO_COMPRESSION_THRESHOLD:
            if self._check_ffmpeg_available():
                # Save original to temp file
                with tempfile.NamedTemporaryFile(suffix=Path(file.filename).suffix, delete=False) as tmp:
                    tmp.write(content)
                    tmp_path = tmp.name
                
                try:
                    # Compress video
                    compressed_path = str(file_path)
                    if self._compress_video(tmp_path, compressed_path, target_size_mb=VIDEO_TARGET_SIZE / (1024*1024)):
                        compressed = True
                        # Update content for metadata calculation
                        with open(compressed_path, "rb") as f:
                            content = f.read()
                    else:
                        # Compression failed, use original if within limits
                        if original_size <= settings.MAX_UPLOAD_SIZE:
                            async with aiofiles.open(file_path, "wb") as f:
                                await f.write(content)
                        else:
                            raise ValueError(f"Video compression failed and file is too large. Max size: {settings.MAX_UPLOAD_SIZE / (1024*1024):.1f}MB")
                finally:
                    # Clean up temp file
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
            else:
                # No ffmpeg, reject if too large
                if original_size > settings.MAX_UPLOAD_SIZE:
                    raise ValueError(f"Video too large and compression not available (ffmpeg not installed). Max size: {settings.MAX_UPLOAD_SIZE / (1024*1024):.1f}MB")
                else:
                    # Within limits, save as is
                    async with aiofiles.open(file_path, "wb") as f:
                        await f.write(content)
        else:
            # Not a video needing compression, save directly
            async with aiofiles.open(file_path, "wb") as f:
                await f.write(content)
        
        # Generate metadata
        metadata = {
            "original_filename": file.filename,
            "content_type": file.content_type,
            "size": len(content),
            "original_size": original_size,
            "compressed": compressed
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
