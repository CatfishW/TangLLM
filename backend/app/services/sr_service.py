"""
Super Resolution service for image upscaling via the SR API.
"""

import aiohttp
import base64
import os
import uuid
from typing import Optional, Dict, Any
from datetime import datetime

from ..config import settings


class SRService:
    """Service for image super resolution using external SR API."""
    
    def __init__(self):
        self.api_base = settings.SR_API_BASE
        self.default_output_format = "png"
        self.default_quality = 95
    
    async def check_health(self) -> Dict[str, Any]:
        """Check if the SR API is available."""
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{self.api_base}/health",
                    timeout=aiohttp.ClientTimeout(total=5)
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        return {
                            "available": True,
                            "status": data.get("status", "unknown"),
                            "model": data.get("model", "unknown"),
                            "device": data.get("device", "unknown")
                        }
                    return {"available": False, "error": f"HTTP {response.status}"}
        except Exception as e:
            return {"available": False, "error": str(e)}
    
    async def upscale_image(
        self,
        image_path: str,
        user_id: int,
        output_format: Optional[str] = None,
        quality: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Upscale an image using the SR API.
        
        Args:
            image_path: Path to the source image file
            user_id: User ID for saving the output
            output_format: Output format (png, jpg, webp)
            quality: Output quality for lossy formats (1-100)
            
        Returns:
            Dict with 'success', 'original_url', 'upscaled_url' (if successful), 'error' (if failed)
        """
        output_format = output_format or self.default_output_format
        quality = quality or self.default_quality
        
        try:
            # Read and encode the source image
            if not os.path.exists(image_path):
                return {
                    "success": False,
                    "error": f"Source image not found: {image_path}"
                }
            
            with open(image_path, "rb") as f:
                image_data = f.read()
            
            image_base64 = base64.b64encode(image_data).decode("utf-8")
            
            # Call the SR API
            async with aiohttp.ClientSession() as session:
                payload = {
                    "image": image_base64,
                    "scale": 4,  # 4x upscaling
                    "output_format": output_format,
                    "quality": quality
                }
                
                async with session.post(
                    f"{self.api_base}/upscale",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=300)  # 5 min timeout for upscaling
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        return {
                            "success": False,
                            "error": f"SR API error ({response.status}): {error_text[:200]}"
                        }
                    
                    data = await response.json()
                    
                    # The API returns base64 image data
                    upscaled_base64 = data.get("image")
                    if not upscaled_base64:
                        return {
                            "success": False,
                            "error": f"No image data in response. Keys: {list(data.keys())}"
                        }
                    
                    # Save the upscaled image
                    upscaled_url = await self._save_image(
                        upscaled_base64,
                        user_id,
                        "upscaled",
                        output_format
                    )
                    
                    # Get original image URL (it's already stored)
                    original_filename = os.path.basename(image_path)
                    original_user_dir = os.path.basename(os.path.dirname(image_path))
                    original_url = f"/api/files/{original_user_dir}/{original_filename}"
                    
                    return {
                        "success": True,
                        "original_url": original_url,
                        "upscaled_url": upscaled_url,
                        "original_width": data.get("width", 0) // 4,  # Approximate
                        "original_height": data.get("height", 0) // 4,
                        "upscaled_width": data.get("width", 0),
                        "upscaled_height": data.get("height", 0),
                        "inference_time_ms": data.get("inference_time_ms", 0)
                    }
                    
        except aiohttp.ClientError as e:
            return {
                "success": False,
                "error": f"Network error: {str(e)}"
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"Unexpected error: {str(e)}"
            }
    
    async def _save_image(
        self,
        base64_data: str,
        user_id: int,
        prefix: str,
        output_format: str
    ) -> str:
        """Save base64 image data to the uploads directory and return the URL."""
        # Create user directory if it doesn't exist
        user_dir = os.path.join(settings.UPLOAD_DIR, str(user_id))
        os.makedirs(user_dir, exist_ok=True)
        
        # Generate unique filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        
        ext = output_format.lower()
        if ext == "jpg":
            ext = "jpeg"
        
        filename = f"sr_{prefix}_{timestamp}_{unique_id}.{ext}"
        filepath = os.path.join(user_dir, filename)
        
        # Decode and save
        try:
            # Clean up the base64 string
            if "," in base64_data:
                base64_data = base64_data.split(",")[1]
            
            # Remove any whitespace
            base64_data = base64_data.strip()
            
            # Fix padding if needed
            missing_padding = len(base64_data) % 4
            if missing_padding:
                base64_data += '=' * (4 - missing_padding)
            
            image_data = base64.b64decode(base64_data)
            with open(filepath, "wb") as f:
                f.write(image_data)
        except Exception as e:
            raise ValueError(f"Failed to decode base64 image: {str(e)}")
        
        # Return the API URL for accessing the file
        return f"/api/files/{user_id}/{filename}"
