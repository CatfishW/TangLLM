"""
Text-to-Image service for generating images via the T2I API.
"""

import aiohttp
import base64
import os
import uuid
from typing import Optional, Dict, Any
from datetime import datetime

from ..config import settings


class T2IService:
    """Service for text-to-image generation using external T2I API."""
    
    def __init__(self):
        self.api_base = settings.T2I_API_BASE
        self.default_width = settings.T2I_DEFAULT_WIDTH
        self.default_height = settings.T2I_DEFAULT_HEIGHT
        self.default_steps = settings.T2I_DEFAULT_STEPS
    
    async def check_health(self) -> Dict[str, Any]:
        """Check if the T2I API is available."""
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
                            "gpu_available": data.get("gpu_available", False),
                            "queue_size": data.get("queue_size", 0)
                        }
                    return {"available": False, "error": f"HTTP {response.status}"}
        except Exception as e:
            return {"available": False, "error": str(e)}
    
    async def generate_image(
        self,
        prompt: str,
        user_id: int,
        width: Optional[int] = None,
        height: Optional[int] = None,
        num_inference_steps: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Generate an image from a text prompt.
        
        Args:
            prompt: The text prompt for image generation
            user_id: User ID for saving the image
            width: Image width (default from config)
            height: Image height (default from config)
            num_inference_steps: Number of inference steps (default from config)
            
        Returns:
            Dict with 'success', 'url' (if successful), 'error' (if failed)
        """
        width = width or self.default_width
        height = height or self.default_height
        num_inference_steps = num_inference_steps or self.default_steps
        
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "prompt": prompt,
                    "width": width,
                    "height": height,
                    "num_inference_steps": num_inference_steps
                }
                
                async with session.post(
                    f"{self.api_base}/generate",
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=600)  # 10 min timeout for generation
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        return {
                            "success": False,
                            "error": f"T2I API error ({response.status}): {error_text[:200]}"
                        }
                    
                    data = await response.json()
                    
                    # The API returns base64 image data
                    image_base64 = data.get("image_base64")
                    if not image_base64:
                        return {
                            "success": False,
                            "error": f"No image data in response. Keys: {list(data.keys())}"
                        }
                    
                    # Save the image to uploads directory
                    image_url = await self._save_image(image_base64, user_id, prompt)
                    
                    return {
                        "success": True,
                        "url": image_url,
                        "prompt": prompt,
                        "width": width,
                        "height": height,
                        "generation_time_ms": data.get("generation_time_ms", 0)
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
    
    async def _save_image(self, base64_data: str, user_id: int, prompt: str) -> str:
        """Save base64 image data to the uploads directory and return the URL."""
        # Create user directory if it doesn't exist
        user_dir = os.path.join(settings.UPLOAD_DIR, str(user_id))
        os.makedirs(user_dir, exist_ok=True)
        
        # Generate unique filename
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        # Create a sanitized prompt snippet for the filename
        prompt_snippet = "".join(c for c in prompt[:30] if c.isalnum() or c == " ").strip()
        prompt_snippet = prompt_snippet.replace(" ", "_")[:20]
        
        filename = f"t2i_{timestamp}_{prompt_snippet}_{unique_id}.png"
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
            # Re-raise with more context
            raise ValueError(f"Failed to decode base64 image: {str(e)}")
        
        # Return the API URL for accessing the file
        return f"/api/files/{user_id}/{filename}"
