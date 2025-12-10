"""
Conversation-related Pydantic schemas.
"""

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class ConversationCreate(BaseModel):
    """Schema for creating a conversation."""
    title: Optional[str] = Field("New Chat", max_length=200)
    system_prompt: Optional[str] = None


class ConversationUpdate(BaseModel):
    """Schema for updating a conversation."""
    title: Optional[str] = Field(None, max_length=200)
    is_shared: Optional[bool] = None
    is_share_editable: Optional[bool] = None


class ConversationBranch(BaseModel):
    """Schema for branching a conversation."""
    message_id: int
    new_title: Optional[str] = None


class ConversationResponse(BaseModel):
    """Conversation response schema."""
    id: int
    user_id: int
    title: str
    summary: Optional[str] = None
    is_shared: bool
    share_token: Optional[str] = None
    message_count: int
    total_tokens: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class ConversationListResponse(BaseModel):
    """Schema for conversation list item."""
    id: int
    title: str
    summary: Optional[str] = None
    message_count: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class ConversationWithMessages(ConversationResponse):
    """Conversation with full message history."""
    messages: List["MessageResponse"] = []


# Import MessageResponse for type hint
from .message import MessageResponse
ConversationWithMessages.model_rebuild()
