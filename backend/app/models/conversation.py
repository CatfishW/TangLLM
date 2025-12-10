"""
Conversation database model.
"""

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Text, Boolean, Index
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from ..database import Base


class Conversation(Base):
    """Conversation/chat session model."""
    
    __tablename__ = "conversations"
    
    # Composite index for faster conversation listing by user ordered by recency
    __table_args__ = (
        Index('ix_conversations_user_updated', 'user_id', 'updated_at'),
    )

    
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    
    # Conversation metadata
    title = Column(String(200), default="New Chat")
    summary = Column(Text, nullable=True)  # AI-generated summary
    
    # Branching support
    parent_id = Column(Integer, ForeignKey("conversations.id"), nullable=True)
    branch_point_message_id = Column(Integer, nullable=True)
    
    # Sharing
    is_shared = Column(Boolean, default=False)
    share_token = Column(String(100), unique=True, nullable=True, index=True)
    is_share_editable = Column(Boolean, default=False)
    
    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
    
    # Statistics
    message_count = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    
    # Relationships
    user = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan", order_by="Message.created_at")
    branches = relationship("Conversation", backref="parent", remote_side=[id])
