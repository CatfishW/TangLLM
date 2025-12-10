"""
LLM service for interacting with the Qwen3-VL model via OpenAI-compatible API.
"""

from openai import AsyncOpenAI
from typing import AsyncGenerator, List, Optional, Dict, Any
import json
import time
import base64
import os
import re
import asyncio

from ..config import settings
from ..schemas.message import MessageContent


class LLMService:
    """Service for LLM interactions with multimodal support."""
    
    def __init__(
        self, 
        api_base: Optional[str] = None, 
        model_id: Optional[str] = None,
        api_key: Optional[str] = None
    ):
        self.api_base = api_base or settings.DEFAULT_API_BASE
        self.model_id = model_id or settings.DEFAULT_MODEL_ID
        self.api_key = api_key or "not-needed"  # vLLM often doesn't require API key
        
        self.client = AsyncOpenAI(
            base_url=self.api_base,
            api_key=self.api_key
        )
    
    async def list_models(self) -> List[Dict[str, Any]]:
        """List available models from the LLM API."""
        try:
            response = await self.client.models.list()
            models = []
            for model in response.data:
                models.append({
                    "id": model.id,
                    "owned_by": getattr(model, "owned_by", "unknown"),
                    "created": getattr(model, "created", None)
                })
            return models
        except Exception as e:
            print(f"Error listing models: {e}")
            return []

    def _get_media_content(self, url: str, media_type: str) -> str:
        """
        Process media URL. If it's a local file, convert to base64 data URI.
        Otherwise return the URL as is.
        """
        if not url:
            return ""
            
        # Check if it's a local file URL (e.g. /api/files/1/filename.png)
        # Match pattern: .../api/files/{user_id}/{filename}
        match = re.search(r'/api/files/(\d+)/([^/]+)$', url)
        
        if match:
            user_id = match.group(1)
            filename = match.group(2)
            file_path = os.path.join(settings.UPLOAD_DIR, user_id, filename)
            
            if os.path.exists(file_path):
                try:
                    with open(file_path, "rb") as f:
                        data = f.read()
                        
                    b64_data = base64.b64encode(data).decode("utf-8")
                    
                    # Determine mime type
                    mime_type = "image/png" # Default
                    ext = os.path.splitext(filename)[1].lower()
                    if ext in ['.jpg', '.jpeg']: mime_type = 'image/jpeg'
                    elif ext == '.gif': mime_type = 'image/gif'
                    elif ext == '.webp': mime_type = 'image/webp'
                    elif ext == '.mp4': mime_type = 'video/mp4'
                    elif ext == '.mov': mime_type = 'video/quicktime'
                    elif ext == '.webm': mime_type = 'video/webm'
                    
                    return f"data:{mime_type};base64,{b64_data}"
                except Exception as e:
                    print(f"Error reading local file {file_path}: {e}")
                    # Fallback to URL if reading fails
                    return url
        
        return url
    
    def _build_message_content(self, content_parts: List[MessageContent]) -> List[Dict[str, Any]]:
        """Build OpenAI-compatible message content for multimodal input."""
        formatted_content = []
        
        for part in content_parts:
            if part.type == "text":
                formatted_content.append({
                    "type": "text",
                    "text": part.text or ""
                })
            elif part.type == "image":
                if part.url:
                    formatted_content.append({
                        "type": "image_url",
                        "image_url": {
                            "url": self._get_media_content(part.url, "image")
                        }
                    })
            elif part.type == "video":
                if part.url:
                    # Qwen3-VL supports video via the video type
                    formatted_content.append({
                        "type": "video_url",
                        "video_url": {
                            "url": self._get_media_content(part.url, "video")
                        }
                    })
        
        return formatted_content
    
    def _build_messages(
        self, 
        conversation_history: List[Dict[str, Any]], 
        new_content: List[MessageContent],
        system_prompt: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Build the full message list for the API call."""
        messages = []
        
        # Add system prompt if provided
        if system_prompt:
            messages.append({
                "role": "system",
                "content": system_prompt
            })
        
        # Add conversation history
        for msg in conversation_history:
            if msg.get("media_url"):
                # Reconstruct multimodal message
                content = []
                if msg.get("media_type") == "image":
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": self._get_media_content(msg["media_url"], "image")}
                    })
                elif msg.get("media_type") == "video":
                    content.append({
                        "type": "video_url",
                        "video_url": {"url": self._get_media_content(msg["media_url"], "video")}
                    })
                if msg.get("content"):
                    content.append({
                        "type": "text",
                        "text": msg["content"]
                    })
                messages.append({
                    "role": msg["role"],
                    "content": content
                })
            else:
                messages.append({
                    "role": msg["role"],
                    "content": msg.get("content", "")
                })
        
        # Add new user message
        new_message_content = self._build_message_content(new_content)
        messages.append({
            "role": "user",
            "content": new_message_content if len(new_message_content) > 1 else (
                new_message_content[0].get("text", "") if new_message_content else ""
            )
        })
        
        return messages
    
    async def chat_stream(
        self,
        conversation_history: List[Dict[str, Any]],
        new_content: List[MessageContent],
        system_prompt: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096
    ) -> AsyncGenerator[str, None]:
        """Stream chat response from the LLM."""
        messages = self._build_messages(conversation_history, new_content, system_prompt)
        
        try:
            stream = await self.client.chat.completions.create(
                model=self.model_id,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
                stream=True
            )
            
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    content = chunk.choices[0].delta.content
                    
                    # Adjusted smoothing logic
                    # 1. Consistent chunk size (3 chars) to avoid fast/slow alternation
                    # 2. Use asyncio.sleep(0) instead of 0.01 to avoid 15ms/tick penalty on Windows
                    #    This prevents "lag" (backlog accumulation) while still breaking up bursts
                    if len(content) > 3:
                        for i in range(0, len(content), 3):
                            yield content[i:i+3]
                            await asyncio.sleep(0.0165)
                    else:
                        yield content
                        # Tiny yield to maintain consistent event loop rhythm
                        await asyncio.sleep(0)
                    
        except Exception as e:
            yield f"\n\n[Error: {str(e)}]"
    
    async def chat(
        self,
        conversation_history: List[Dict[str, Any]],
        new_content: List[MessageContent],
        system_prompt: Optional[str] = None,
        temperature: float = 0.7,
        max_tokens: int = 4096
    ) -> Dict[str, Any]:
        """Non-streaming chat response."""
        messages = self._build_messages(conversation_history, new_content, system_prompt)
        
        start_time = time.time()
        
        response = await self.client.chat.completions.create(
            model=self.model_id,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            stream=False
        )
        
        generation_time = int((time.time() - start_time) * 1000)
        
        return {
            "content": response.choices[0].message.content,
            "tokens_used": response.usage.total_tokens if response.usage else 0,
            "generation_time": generation_time,
            "model_id": self.model_id
        }
    
    async def generate_title(self, first_message: str) -> str:
        """Generate a title for a conversation based on the first message."""
        try:
            response = await self.client.chat.completions.create(
                model=self.model_id,
                messages=[
                    {
                        "role": "system",
                        "content": "Generate a very short title (max 6 words) for a conversation that starts with the following message. Only respond with the title, nothing else."
                    },
                    {
                        "role": "user",
                        "content": first_message[:500]
                    }
                ],
                temperature=0.3,
                max_tokens=50
            )
            
            title = response.choices[0].message.content.strip()
            # Clean up the title
            title = title.strip('"\'')
            return title[:100]  # Limit length
            
        except Exception:
            # Fallback to first words of message
            words = first_message.split()[:5]
            return " ".join(words) + "..." if len(words) >= 5 else first_message[:50]
