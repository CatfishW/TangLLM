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
from ..services.t2i_service import T2IService
from ..services.tts_service import TTSService
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
    
    # Enhance system prompt for T2I intent detection
    t2i_instruction = (
        "\n\nIf the user explicitly asks to generate, create, draw, or make an image/picture/photo, "
        "respond ONLY with the following format:\n"
        "[T2I_REQUEST: <detailed prompt for image generation>]\n\n"
        "If the user explicitly asks to speak, say, read aloud, or generate audio/voice/speech, "
        "respond ONLY with the following format:\n"
        "[TTS_REQUEST: <text to speak>]\n\n"
        "Enhance the user's request into a detailed, high-quality image generation prompt OR clean text to speak. "
        "Do not provide any other text response for these specific requests."
    )
    
    if system_prompt:
        system_prompt += t2i_instruction
    else:
        system_prompt = "You are a helpful assistant." + t2i_instruction
    
    # Get thinking mode from user settings
    thinking_mode = getattr(user_settings, 'thinking_mode', 'auto') if user_settings else 'auto'
    
    # Determine if thinking should be enabled based on mode
    if thinking_mode == 'fast':
        enable_thinking = False
    elif thinking_mode == 'thinking':
        enable_thinking = True
    else:  # auto mode - enable for longer inputs
        text_length = sum(len(c.text or '') for c in chat_request.content if c.text)
        enable_thinking = text_length > 100  # Enable thinking for longer prompts
    
    if chat_request.stream:
        # Streaming response
        async def generate():
            full_response = ""
            
            # T2I Buffering variables
            t2i_buffer = ""
            checking_for_marker = True
            marker_detected = False
            
            try:
                async for chunk in llm_service.chat_stream(
                    conversation_history,
                    chat_request.content,
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    enable_thinking=enable_thinking
                ):
                    # Check for thinking blocks first
                    if "<think>" in chunk or "</think>" in chunk:
                         full_response += chunk
                         yield f"data: {json.dumps({'type': 'content', 'content': chunk})}\n\n"
                         
                         # Parse thinking mode disable - if we see thinking tags, disable T2I check
                         if checking_for_marker:
                             checking_for_marker = False
                             if t2i_buffer:
                                 yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                                 full_response += t2i_buffer
                                 t2i_buffer = ""
                         continue

                    # If we are checking for marker
                    if checking_for_marker:
                        t2i_buffer += chunk
                        clean_buffer = t2i_buffer.lstrip()
                        
                        # Check start
                        if clean_buffer.startswith("[T2I_REQUEST:"):
                            marker_detected = True
                            checking_for_marker = False # Switch to capture mode
                        # If buffer is long enough and doesn't start with marker prefix
                        elif len(clean_buffer) > 20 and not "[T2I_REQUEST:".startswith(clean_buffer[:10]):
                            # Flush buffer
                            yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                            full_response += t2i_buffer
                            t2i_buffer = ""
                            checking_for_marker = False
                        # Else continue buffering
                    elif marker_detected:
                        t2i_buffer += chunk # Accumulate prompt
                    else:
                        # Normal streaming
                        full_response += chunk
                        yield f"data: {json.dumps({'type': 'content', 'content': chunk})}\n\n"
                    
                    await asyncio.sleep(0)
                
                # End of stream processing
                if marker_detected or (checking_for_marker and (t2i_buffer.strip().startswith("[T2I_REQUEST:") or t2i_buffer.strip().startswith("[TTS_REQUEST:"))):
                    full_param = t2i_buffer.strip()
                    
                    # --- T2I Handling ---
                    if "[T2I_REQUEST:" in full_param:
                        prefix = "[T2I_REQUEST:"
                        start_idx = full_param.find(prefix)
                        if start_idx != -1:
                            content_after = full_param[start_idx + len(prefix):].strip()
                            if content_after.endswith("]"): content_after = content_after[:-1].strip()
                            prompt = content_after
                            
                            if prompt:
                                progress_msg = f"Generating image for: **{prompt}**..."
                                yield f"data: {json.dumps({'type': 'content', 'content': progress_msg})}\n\n"
                                
                                t2i_service_inst = T2IService()
                                result = await t2i_service_inst.generate_image(prompt, current_user.id)
                                
                                if result["success"]:
                                    yield f"data: {json.dumps({'type': 'image_generated', 'url': result['url'], 'prompt': prompt})}\n\n"
                                    full_response = f"Generated image for: {prompt}\n![{prompt}]({result['url']})"
                                else:
                                    err_msg = f"\nFailed to generate image: {result.get('error')}"
                                    yield f"data: {json.dumps({'type': 'content', 'content': err_msg})}\n\n"
                                    full_response = f"Request: {prompt}\n{err_msg}"
                            else:
                                yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                                full_response += t2i_buffer
                        else:
                            yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                            full_response += t2i_buffer

                    # --- TTS Handling ---
                    elif "[TTS_REQUEST:" in full_param:
                        prefix = "[TTS_REQUEST:"
                        start_idx = full_param.find(prefix)
                        if start_idx != -1:
                            content_after = full_param[start_idx + len(prefix):].strip()
                            if content_after.endswith("]"): content_after = content_after[:-1].strip()
                            tts_text = content_after
                            
                            if tts_text:
                                progress_msg = f"Generating audio for: **{tts_text}**..."
                                yield f"data: {json.dumps({'type': 'content', 'content': progress_msg})}\n\n"
                                
                                # Check for uploaded audio file to use as voice
                                voice_path = None
                                is_upload = False
                                
                                # Scan chat_request.content for media URLs if we want to determine voice
                                # Currently we check if there was a file upload in the context
                                # Since we don't have direct access to 'files' here easily unless we look at request content content list
                                # We check content list for other items
                                
                                for item in chat_request.content:
                                     # Assuming 'image' or 'video' - but we might have 'audio' if supported or treat video as audio source?
                                     # The user prompt likely contained the audio reference
                                     # For now, let's look for explicit patterns in tts_text if user said @[filename]?
                                     # Or logic: check for 'audio' typed message content?
                                     # Let's rely on backend file service path if we can find it?
                                     pass
                                
                                # Actually, simply check if the user uploaded a file in this turn
                                # The ChatRequest comes with list of content.
                                # If any content item is a URL to /api/files/..., we can use it.
                                # But we need to know if it's audio.
                                # Let's peek at extensions in the URL.
                                
                                for item in chat_request.content:
                                    if item.url and "/api/files/" in item.url:
                                        ext = os.path.splitext(item.url)[1].lower()
                                        if ext in ['.wav', '.mp3', '.m4a', '.ogg', '.flac']:
                                            # Found audio file!
                                            match = re.search(r'/api/files/(\d+)/([^/]+)$', item.url)
                                            if match:
                                                f_uid = match.group(1)
                                                f_name = match.group(2)
                                                file_path = os.path.join(settings.UPLOAD_DIR, f_uid, f_name)
                                                if os.path.exists(file_path):
                                                    voice_path = file_path
                                                    is_upload = True
                                                    break

                                tts_service_inst = TTSService()
                                result = await tts_service_inst.generate_speech(tts_text, current_user.id, voice_path, is_upload)
                                
                                if result["success"]:
                                    yield f"data: {json.dumps({'type': 'audio_generated', 'url': result['url'], 'text': tts_text})}\n\n"
                                    # Markdown audio player? Not standard. Use text link or message.
                                    # We'll rely on frontend specific event to render player.
                                    full_response = f"Generated audio for: {tts_text}\n[Audio]({result['url']})"
                                else:
                                    err_msg = f"\nFailed to generate audio: {result.get('error')}"
                                    yield f"data: {json.dumps({'type': 'content', 'content': err_msg})}\n\n"
                                    full_response = f"Request: {tts_text}\n{err_msg}"
                            else:
                                yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                                full_response += t2i_buffer
                        else:
                             yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                             full_response += t2i_buffer
                    
                    else:
                         yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                         full_response += t2i_buffer
                        
                elif t2i_buffer:
                    # Leftover buffer flush
                    yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                    full_response += t2i_buffer
                
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
                
                # Generate title if first message (simple text parsing, no LLM)
                if len(messages) == 0 and text_content:
                    # Use first 5 words or first 50 chars
                    words = text_content.split()[:5]
                    if len(words) >= 5:
                        conversation.title = " ".join(words) + "..."
                    elif len(text_content) > 50:
                        conversation.title = text_content[:50] + "..."
                    else:
                        conversation.title = text_content
                
                await db.commit()
                
                # Check for object detection coordinates and annotate image if present
                annotation_url = None
                if annotation_media_url and annotation_media_type == "image":
                    annotation_service = AnnotationService()
                    
                    # Check if it's a local file or external URL
                    if annotation_media_url.startswith('/api/files/'):
                        # Local file - get path from URL
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
                    elif annotation_media_url.startswith('http'):
                        # External URL - pass URL directly to annotation service
                        annotation_url = annotation_service.process_detection_response(
                            full_response,
                            annotation_media_url,  # Pass URL as image source
                            current_user.id,
                            "url_image.jpg",
                            user_prompt=text_content
                        )
                
                # Send annotation event if we created an annotated image
                if annotation_url:
                    yield f"data: {json.dumps({'type': 'annotation', 'url': annotation_url})}\n\n"
                
                yield f"data: {json.dumps({'type': 'done', 'message_id': assistant_message.id, 'conversation_id': conversation.id, 'title': conversation.title})}\n\n"
                
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
            
            # Generate title if first message (simple text parsing, no LLM)
            if len(messages) == 0 and text_content:
                # Use first 5 words or first 50 chars
                words = text_content.split()[:5]
                if len(words) >= 5:
                    conversation.title = " ".join(words) + "..."
                elif len(text_content) > 50:
                    conversation.title = text_content[:50] + "..."
                else:
                    conversation.title = text_content
            
            await db.commit()
            await db.refresh(assistant_message)
            
            # Check for object detection coordinates and annotate image if present
            annotation_url = None
            if annotation_media_url and annotation_media_type == "image":
                annotation_service = AnnotationService()
                
                # Check if it's a local file or external URL
                if annotation_media_url.startswith('/api/files/'):
                    # Local file - get path from URL
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
                elif annotation_media_url.startswith('http'):
                    # External URL - pass URL directly to annotation service
                    annotation_url = annotation_service.process_detection_response(
                        response["content"],
                        annotation_media_url,  # Pass URL as image source
                        current_user.id,
                        "url_image.jpg",
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
