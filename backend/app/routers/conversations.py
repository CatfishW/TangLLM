"""
Conversation management routes.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import List
import secrets

from ..database import get_db
from ..schemas.conversation import (
    ConversationCreate,
    ConversationUpdate,
    ConversationResponse,
    ConversationListResponse,
    ConversationWithMessages,
    ConversationBranch
)
from ..schemas.message import MessageResponse
from ..models.user import User
from ..models.conversation import Conversation
from ..models.message import Message
from ..utils.security import get_current_user, get_current_user_optional


router = APIRouter(prefix="/api/conversations", tags=["Conversations"])


@router.get("", response_model=List[ConversationListResponse])
async def list_conversations(
    skip: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List all conversations for the current user."""
    result = await db.execute(
        select(Conversation)
        .filter(Conversation.user_id == current_user.id)
        .order_by(desc(Conversation.updated_at))
        .offset(skip)
        .limit(limit)
    )
    conversations = result.scalars().all()
    return conversations


@router.post("", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
async def create_conversation(
    conversation_data: ConversationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a new conversation."""
    conversation = Conversation(
        user_id=current_user.id,
        title=conversation_data.title or "New Chat"
    )
    
    # Add system message if provided
    if conversation_data.system_prompt:
        db.add(conversation)
        await db.flush()
        
        system_message = Message(
            conversation_id=conversation.id,
            role="system",
            content=conversation_data.system_prompt
        )
        db.add(system_message)
    else:
        db.add(conversation)
    
    await db.commit()
    await db.refresh(conversation)
    
    return conversation


@router.get("/{conversation_id}", response_model=ConversationWithMessages)
async def get_conversation(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get a conversation with all messages."""
    result = await db.execute(
        select(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id
        )
    )
    conversation = result.scalar_one_or_none()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found"
        )
    
    # Get messages
    result = await db.execute(
        select(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    
    return {
        **ConversationResponse.model_validate(conversation).model_dump(),
        "messages": [MessageResponse.model_validate(msg) for msg in messages]
    }


@router.get("/shared/{share_token}", response_model=ConversationWithMessages)
async def get_shared_conversation(
    share_token: str,
    db: AsyncSession = Depends(get_db)
):
    """Get a shared conversation by share token."""
    result = await db.execute(
        select(Conversation).filter(
            Conversation.share_token == share_token,
            Conversation.is_shared == True
        )
    )
    conversation = result.scalar_one_or_none()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Shared conversation not found"
        )
    
    # Get messages
    result = await db.execute(
        select(Message)
        .filter(Message.conversation_id == conversation.id)
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    
    return {
        **ConversationResponse.model_validate(conversation).model_dump(),
        "messages": [MessageResponse.model_validate(msg) for msg in messages]
    }


@router.put("/{conversation_id}", response_model=ConversationResponse)
async def update_conversation(
    conversation_id: int,
    updates: ConversationUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Update a conversation."""
    result = await db.execute(
        select(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id
        )
    )
    conversation = result.scalar_one_or_none()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found"
        )
    
    # Update fields
    if updates.title is not None:
        conversation.title = updates.title
    
    if updates.is_shared is not None:
        conversation.is_shared = updates.is_shared
        if updates.is_shared and not conversation.share_token:
            conversation.share_token = secrets.token_urlsafe(16)
    
    if updates.is_share_editable is not None:
        conversation.is_share_editable = updates.is_share_editable
    
    await db.commit()
    await db.refresh(conversation)
    
    return conversation


@router.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete a conversation."""
    result = await db.execute(
        select(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id
        )
    )
    conversation = result.scalar_one_or_none()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found"
        )
    
    await db.delete(conversation)
    await db.commit()
    
    return {"message": "Conversation deleted"}


@router.delete("/")
async def delete_all_conversations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Delete all conversations for the current user."""
    # Delete all messages first (cascade usually handles this, but explicit is safe)
    # Actually, if we delete conversations, messages should cascade if FK is set up right
    # Let's just delete conversations for this user
    
    result = await db.execute(
        select(Conversation).filter(Conversation.user_id == current_user.id)
    )
    conversations = result.scalars().all()
    
    if not conversations:
        return {"message": "No conversations to delete"}
        
    for conversation in conversations:
        await db.delete(conversation)
        
    await db.commit()
    
    return {"message": "All conversations deleted"}


@router.post("/{conversation_id}/branch", response_model=ConversationResponse)
async def branch_conversation(
    conversation_id: int,
    branch_data: ConversationBranch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Create a branch from a specific message in a conversation."""
    # Get original conversation
    result = await db.execute(
        select(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id
        )
    )
    original = result.scalar_one_or_none()
    
    if not original:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found"
        )
    
    # Get messages up to branch point
    result = await db.execute(
        select(Message)
        .filter(
            Message.conversation_id == conversation_id,
            Message.id <= branch_data.message_id
        )
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    
    if not messages:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid branch point"
        )
    
    # Create new conversation
    new_conversation = Conversation(
        user_id=current_user.id,
        title=branch_data.new_title or f"{original.title} (Branch)",
        parent_id=conversation_id,
        branch_point_message_id=branch_data.message_id
    )
    db.add(new_conversation)
    await db.flush()
    
    # Copy messages up to branch point
    for msg in messages:
        new_message = Message(
            conversation_id=new_conversation.id,
            role=msg.role,
            content=msg.content,
            media_type=msg.media_type,
            media_url=msg.media_url,
            media_metadata=msg.media_metadata
        )
        db.add(new_message)
    
    # Mark original message as branch point
    result = await db.execute(
        select(Message).filter(Message.id == branch_data.message_id)
    )
    branch_message = result.scalar_one_or_none()
    if branch_message:
        branch_message.is_branch_point = True
    
    new_conversation.message_count = len(messages)
    
    await db.commit()
    await db.refresh(new_conversation)
    
    return new_conversation


@router.get("/{conversation_id}/export")
async def export_conversation(
    conversation_id: int,
    format: str = "markdown",
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Export a conversation to markdown or JSON."""
    result = await db.execute(
        select(Conversation).filter(
            Conversation.id == conversation_id,
            Conversation.user_id == current_user.id
        )
    )
    conversation = result.scalar_one_or_none()
    
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Conversation not found"
        )
    
    # Get messages
    result = await db.execute(
        select(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    
    if format == "markdown":
        md_content = f"# {conversation.title}\n\n"
        md_content += f"*Exported from TangLLM*\n\n---\n\n"
        
        for msg in messages:
            if msg.role == "user":
                md_content += f"## 👤 User\n\n"
            elif msg.role == "assistant":
                md_content += f"## 🤖 Assistant\n\n"
            else:
                md_content += f"## ⚙️ System\n\n"
            
            md_content += f"{msg.content}\n\n"
            
            if msg.media_url:
                md_content += f"*Attached: {msg.media_type} - {msg.media_url}*\n\n"
            
            md_content += "---\n\n"
        
        return {"format": "markdown", "content": md_content}
    
    else:  # JSON format
        return {
            "format": "json",
            "content": {
                "title": conversation.title,
                "created_at": conversation.created_at.isoformat(),
                "messages": [
                    {
                        "role": msg.role,
                        "content": msg.content,
                        "media_type": msg.media_type,
                        "media_url": msg.media_url,
                        "created_at": msg.created_at.isoformat()
                    }
                    for msg in messages
                ]
            }
        }
