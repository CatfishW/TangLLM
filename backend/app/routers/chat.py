"""
Chat routes with streaming support.
"""

from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import json
import asyncio
import os
import re

from ..database import get_db
from ..schemas.message import ChatRequest, MessageResponse, ChatResponse
from ..models.user import User, UserSettings
from ..models.conversation import Conversation
from ..models.message import Message
from ..services.llm_service import LLMService
from ..services.auth_service import AuthService
from ..services.annotation_service import AnnotationService
from ..utils.security import get_current_user
from ..config import settings


router = APIRouter(prefix="/api/chat", tags=["Chat"])


@router.get("/models")
async def list_models(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List available LLM models from the configured API."""
    llm_service = await get_llm_service(current_user, db)
    models = await llm_service.list_models()
    return {"models": models}


async def get_llm_service(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
) -> LLMService:
    """Get LLM service configured with user settings."""
    auth_service = AuthService(db)
    user_settings = await auth_service.get_user_settings(current_user.id)
    
    return LLMService(
        api_base=user_settings.api_base_url if user_settings else None,
        model_id=user_settings.model_id if user_settings else None,
        api_key=user_settings.api_key if user_settings else None
    )


@router.post("")
async def send_message(
    request: Request,
    chat_request: ChatRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Send a chat message and receive a response (streaming or non-streaming)."""
    llm_service = await get_llm_service(current_user, db)
    
    # Get or create conversation
    if chat_request.conversation_id:
        result = await db.execute(
            select(Conversation).filter(
                Conversation.id == chat_request.conversation_id,
                Conversation.user_id == current_user.id
            )
        )
        conversation = result.scalar_one_or_none()
        if not conversation:
            print(f"[ERROR] [PID:{os.getpid()}] Conversation not found! Requested ID: {chat_request.conversation_id}, User ID: {current_user.id}")
            print(f"[ERROR] [PID:{os.getpid()}] Database URL: {settings.DATABASE_URL}")
            
            # Check if conversation exists for ANY user to debug ownership issues
            verify_result = await db.execute(
                 select(Conversation).filter(Conversation.id == chat_request.conversation_id)
            )
            verify_conv = verify_result.scalar_one_or_none()
            if verify_conv:
                print(f"[ERROR] [PID:{os.getpid()}] Conversation {chat_request.conversation_id} exists but belongs to User ID: {verify_conv.user_id}")
            else:
                print(f"[ERROR] [PID:{os.getpid()}] Conversation {chat_request.conversation_id} does not exist in the database.")
                
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Conversation not found"
            )
    else:
        # Create new conversation
        conversation = Conversation(
            user_id=current_user.id,
            title="New Chat"
        )
        db.add(conversation)
        await db.commit()
        await db.refresh(conversation)
    
    # Get conversation history
    result = await db.execute(
        select(Message).filter(
            Message.conversation_id == conversation.id
        ).order_by(Message.created_at)
    )
    messages = result.scalars().all()
    
    conversation_history = [
        {
            "role": msg.role,
            "content": msg.content,
            "media_type": msg.media_type,
            "media_url": msg.media_url
        }
        for msg in messages
    ]
    
    # Extract text content and media for user message
    text_content = ""
    current_media_type = None
    current_media_url = None
    
    for part in chat_request.content:
        if part.type == "text":
            text_content = part.text or ""
        elif part.type in ["image", "video"]:
            current_media_type = part.type
            current_media_url = part.url
    
    # For annotation: use current image or fall back to recent image from history
    annotation_media_type = current_media_type
    annotation_media_url = current_media_url
    
    if not annotation_media_url:
        for msg in reversed(conversation_history):
            if msg.get("media_type") == "image" and msg.get("media_url"):
                annotation_media_type = "image"
                annotation_media_url = msg["media_url"]
                break
    
    # Save user message with ONLY its own content (not inherited media)
    user_message = Message(
        conversation_id=conversation.id,
        role="user",
        content=text_content,
        media_type=current_media_type,
        media_url=current_media_url
    )
    db.add(user_message)
    await db.commit()
    await db.refresh(user_message)
    
    # Get user settings for system prompt and temperature
    auth_service = AuthService(db)
    user_settings = await auth_service.get_user_settings(current_user.id)
    system_prompt = user_settings.system_prompt if user_settings else None
    temperature = float(user_settings.temperature) if user_settings else 0.7
    max_tokens = user_settings.max_tokens if user_settings else 4096
    
    if chat_request.stream:
        # Streaming response
        async def generate():
            full_response = ""
            
            try:
                async for chunk in llm_service.chat_stream(
                    conversation_history,
                    chat_request.content,
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens
                ):
                    full_response += chunk
                    yield f"data: {json.dumps({'type': 'content', 'content': chunk})}\n\n"
                    # Force yield to event loop to ensure smoother streaming
                    await asyncio.sleep(0)
                
                # Save assistant message
                assistant_message = Message(
                    conversation_id=conversation.id,
                    role="assistant",
                    content=full_response,
                    model_id=llm_service.model_id
                )
                db.add(assistant_message)
                
                # Update conversation
                conversation.message_count = len(messages) + 2
                
                # Generate title if first message
                if len(messages) == 0 and text_content:
                    try:
                        title = await llm_service.generate_title(text_content)
                        conversation.title = title
                    except Exception:
                        conversation.title = text_content[:50] + "..." if len(text_content) > 50 else text_content
                
                await db.commit()
                
                # Check for object detection coordinates and annotate image if present
                annotation_url = None
                if annotation_media_url and annotation_media_type == "image":
                    annotation_service = AnnotationService()
                    # Get the actual file path from the media URL
                    match = re.search(r'/api/files/(\d+)/([^/]+)$', annotation_media_url)
                    if match:
                        file_user_id = match.group(1)
                        filename = match.group(2)
                        file_path = os.path.join(settings.UPLOAD_DIR, file_user_id, filename)
                        if os.path.exists(file_path):
                            annotation_url = annotation_service.process_detection_response(
                                full_response,
                                file_path,
                                current_user.id,
                                filename,
                                user_prompt=text_content
                            )
                
                # Send annotation event if we created an annotated image
                if annotation_url:
                    yield f"data: {json.dumps({'type': 'annotation', 'url': annotation_url})}\n\n"
                
                yield f"data: {json.dumps({'type': 'done', 'message_id': assistant_message.id, 'conversation_id': conversation.id})}\n\n"
                
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
        
        return StreamingResponse(
            generate(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )
    else:
        # Non-streaming response
        try:
            response = await llm_service.chat(
                conversation_history,
                chat_request.content,
                system_prompt=system_prompt,
                temperature=temperature,
                max_tokens=max_tokens
            )
            
            # Save assistant message
            assistant_message = Message(
                conversation_id=conversation.id,
                role="assistant",
                content=response["content"],
                tokens_used=response["tokens_used"],
                generation_time=response["generation_time"],
                model_id=response["model_id"]
            )
            db.add(assistant_message)
            
            # Update conversation
            conversation.message_count = len(messages) + 2
            conversation.total_tokens += response["tokens_used"]
            
            # Generate title if first message
            if len(messages) == 0 and text_content:
                try:
                    title = await llm_service.generate_title(text_content)
                    conversation.title = title
                except Exception:
                    conversation.title = text_content[:50] + "..." if len(text_content) > 50 else text_content
            
            await db.commit()
            await db.refresh(assistant_message)
            
            # Check for object detection coordinates and annotate image if present
            annotation_url = None
            if annotation_media_url and annotation_media_type == "image":
                annotation_service = AnnotationService()
                # Get the actual file path from the media URL
                match = re.search(r'/api/files/(\d+)/([^/]+)$', annotation_media_url)
                if match:
                    file_user_id = match.group(1)
                    filename = match.group(2)
                    file_path = os.path.join(settings.UPLOAD_DIR, file_user_id, filename)
                    if os.path.exists(file_path):
                        annotation_url = annotation_service.process_detection_response(
                            response["content"],
                            file_path,
                            current_user.id,
                            filename,
                            user_prompt=text_content
                        )
            
            result = ChatResponse(
                message=MessageResponse.model_validate(assistant_message),
                conversation_id=conversation.id
            )
            
            # Add annotation URL to response if present
            if annotation_url:
                result_dict = result.model_dump()
                result_dict["annotation_url"] = annotation_url
                return result_dict
            
            return result
            
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=str(e)
            )
