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
async def get_file(user_id: int, filename: str, request: Request):
    """Serve an uploaded file with Range support for video streaming."""
    relative_path = f"{user_id}/{filename}"
    file_path = file_service.get_file_path(relative_path)
    
    if not file_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found"
        )
    
    # Handle Range header for video seeking
    range_header = request.headers.get("range")
    if range_header:
        import os
        from fastapi.responses import StreamingResponse
        
        file_size = os.path.getsize(file_path)
        try:
            start, end = range_header.replace("bytes=", "").split("-")
            start = int(start)
            end = int(end) if end else file_size - 1
        except ValueError:
            start = 0
            end = file_size - 1
            
        if start >= file_size:
            # Range not satisfiable
            raise HTTPException(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                detail="Requested range not satisfiable"
            )
            
        chunk_size = end - start + 1
        
        def iterfile():
            with open(file_path, mode="rb") as file_like:
                file_like.seek(start)
                bytes_to_read = chunk_size
                block_size = 1024 * 64 # 64k chunks
                while bytes_to_read > 0:
                    chunk = file_like.read(min(block_size, bytes_to_read))
                    if not chunk:
                        break
                    yield chunk
                    bytes_to_read -= len(chunk)
                    
        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
            "Content-Type": "video/mp4" if str(file_path).endswith(".mp4") else "application/octet-stream",
        }
        
        return StreamingResponse(
            iterfile(),
            status_code=status.HTTP_206_PARTIAL_CONTENT,
            headers=headers,
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
