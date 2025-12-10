"""
Message-related Pydantic schemas.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Any, Dict
from datetime import datetime


class MessageContent(BaseModel):
    """Schema for multimodal message content."""
    type: str  # "text", "image", "video"
    text: Optional[str] = None
    url: Optional[str] = None  # For image/video URLs


class ChatRequest(BaseModel):
    """Schema for sending a chat message."""
    conversation_id: Optional[int] = None  # If None, create new conversation
    content: List[MessageContent]
    stream: bool = True


class MessageCreate(BaseModel):
    """Schema for creating a message."""
    role: str = Field(..., pattern=r"^(user|assistant|system)$")
    content: str
    media_type: Optional[str] = None
    media_url: Optional[str] = None


class MessageUpdate(BaseModel):
    """Schema for updating a message."""
    is_bookmarked: Optional[bool] = None
    reactions: Optional[List[str]] = None


class MessageResponse(BaseModel):
    """Message response schema."""
    id: int
    conversation_id: int
    role: str
    content: Optional[str] = None
    media_type: Optional[str] = None
    media_url: Optional[str] = None
    media_metadata: Optional[Dict[str, Any]] = None
    tokens_used: int
    generation_time: Optional[int] = None
    model_id: Optional[str] = None
    is_bookmarked: bool
    reactions: List[str] = []
    created_at: datetime
    
    class Config:
        from_attributes = True


class StreamChunk(BaseModel):
    """Schema for streaming response chunk."""
    type: str  # "content", "done", "error"
    content: Optional[str] = None
    message_id: Optional[int] = None
    conversation_id: Optional[int] = None
    error: Optional[str] = None


class ChatResponse(BaseModel):
    """Non-streaming chat response."""
    message: MessageResponse
    conversation_id: int
