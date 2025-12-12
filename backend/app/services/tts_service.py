"""
Text-to-Speech service for generating audio via the TTS API.
"""

import aiohttp
import base64
import os
import uuid
import json
from typing import Optional, Dict, Any, Union
from datetime import datetime

from ..config import settings


class TTSService:
    """
    Service for text-to-speech generation using external TTS API.
    Supports both server-side voice paths and uploaded voice files.
    """
    
    def __init__(self):
        self.api_base = settings.TTS_API_BASE
        self.default_voice = settings.TTS_DEFAULT_VOICE
    
    async def generate_speech(
        self,
        text: str,
        user_id: int,
        voice_path: Optional[str] = None,
        is_upload_voice: bool = False
    ) -> Dict[str, Any]:
        """
        Generate speech from text.
        
        Args:
            text: Text to synthesize
            user_id: User ID for saving the output
            voice_path: Path to voice file (server path or local path if is_upload_voice=True)
            is_upload_voice: Whether voice_path refers to a local file to be uploaded
            
        Returns:
            Dict with 'success', 'url' (if successful), 'error' (if failed)
        """
        try:
            if is_upload_voice and voice_path:
                return await self._generate_with_upload(text, user_id, voice_path)
            else:
                voice = voice_path or self.default_voice
                return await self._generate_simple(text, user_id, voice)
                
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

    async def _generate_simple(self, text: str, user_id: int, voice_path: str) -> Dict[str, Any]:
        """Generate speech using a server-side voice path."""
        async with aiohttp.ClientSession() as session:
            payload = {
                "text": text,
                "speaker_audio_path": voice_path,
                "emo_alpha": 1.0,
                "return_raw_audio": False  # Use base64 response for consistency
            }
            
            async with session.post(
                f"{self.api_base}/tts",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=300)
            ) as response:
                if response.status != 200:
                    error_text = await response.text()
                    return {
                        "success": False,
                        "error": f"TTS API error ({response.status}): {error_text[:200]}"
                    }
                
                data = await response.json()
                if not data.get("success"):
                     return {
                        "success": False,
                        "error": data.get("error", "Unknown TTS error")
                    }
                
                # Decode base64 audio
                audio_base64 = data.get("audio_base64")
                if not audio_base64:
                    return {
                        "success": False,
                        "error": "No audio data in response"
                    }
                
                return await self._save_audio(audio_base64, user_id, text)

    async def _generate_with_upload(self, text: str, user_id: int, local_voice_path: str) -> Dict[str, Any]:
        """Generate speech by uploading a local voice file."""
        if not os.path.exists(local_voice_path):
             return {
                "success": False,
                "error": f"Voice file not found: {local_voice_path}"
            }
            
        async with aiohttp.ClientSession() as session:
            # Prepare multipart upload
            data = aiohttp.FormData()
            data.add_field('text', text)
            data.add_field('emo_alpha', '1.0')
            
            # Add file
            f = open(local_voice_path, 'rb')
            try:
                data.add_field('speaker_audio', f, filename='speaker.wav', content_type='audio/wav')
                
                async with session.post(
                    f"{self.api_base}/tts/upload",
                    data=data,
                    timeout=aiohttp.ClientTimeout(total=300)
                ) as response:
                    if response.status != 200:
                        error_text = await response.text()
                        return {
                            "success": False,
                            "error": f"TTS API error ({response.status}): {error_text[:200]}"
                        }
                    
                    # This endpoint returns RAW AUDIO bytes by default in the client script, 
                    # but let's check content type or if we can force JSON?
                    # The client script says: /tts/upload returns raw audio bytes.
                    
                    audio_bytes = await response.read()
                    
                    # Convert to base64 for saving (reusing _save_audio logic which takes base64)
                    # OR specific save logic
                    return await self._save_audio_bytes(audio_bytes, user_id, text)
                    
            finally:
                f.close()

    async def _save_audio(self, base64_data: str, user_id: int, text: str) -> Dict[str, Any]:
        """Save base64 audio data to uploads."""
        try:
            audio_bytes = base64.b64decode(base64_data)
            return await self._save_audio_bytes(audio_bytes, user_id, text)
        except Exception as e:
            return {"success": False, "error": f"Decoding error: {str(e)}"}

    async def _save_audio_bytes(self, audio_bytes: bytes, user_id: int, text: str) -> Dict[str, Any]:
        """Save audio bytes to uploads."""
        user_dir = os.path.join(settings.UPLOAD_DIR, str(user_id))
        os.makedirs(user_dir, exist_ok=True)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        unique_id = str(uuid.uuid4())[:8]
        text_snippet = "".join(c for c in text[:20] if c.isalnum() or c == " ").strip().replace(" ", "_")
        
        filename = f"tts_{timestamp}_{text_snippet}_{unique_id}.wav"
        filepath = os.path.join(user_dir, filename)
        
        with open(filepath, "wb") as f:
            f.write(audio_bytes)
            
        return {
            "success": True,
            "url": f"/api/files/{user_id}/{filename}",
            "text": text
        }
