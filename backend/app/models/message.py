"""
Message database model.
"""

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean, JSON
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from ..database import Base


class Message(Base):
    """Chat message model with multimodal support."""
    
    __tablename__ = "messages"
    
    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    
    # Message content
    role = Column(String(20), nullable=False)  # "user", "assistant", "system"
    content = Column(Text, nullable=True)
    
    # Multimodal support
    media_type = Column(String(20), nullable=True)  # "image", "video", null
    media_url = Column(String(500), nullable=True)
    media_metadata = Column(JSON, nullable=True)  # Additional media info
    
    # Message metadata
    tokens_used = Column(Integer, default=0)
    generation_time = Column(Integer, nullable=True)  # ms
    model_id = Column(String(200), nullable=True)
    
    # Reactions and bookmarks
    is_bookmarked = Column(Boolean, default=False)
    reactions = Column(JSON, default=list)  # List of emoji reactions
    
    # For branching - marks if this is the branch point
    is_branch_point = Column(Boolean, default=False)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # Relationships
    conversation = relationship("Conversation", back_populates="messages")
