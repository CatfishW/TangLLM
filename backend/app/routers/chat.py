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
        elif part.type in ["image", "video", "audio"]:
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
    
    # Enhance system prompt for T2I/TTS intent detection
    t2i_instruction = (
        "\n\n=== GENERATION CAPABILITIES ==="
        "\n\nYou have access to Image Generation and Text-to-Speech."
        "\n\n**1. FOR IMAGES:** Use `[T2I_REQUEST: detailed prompt]`"
        "\n**2. FOR AUDIO:** Use `[TTS_REQUEST: text to speak]`"
        "\n\n**CRITICAL RULES:**"
        "\n- You MUST use these exact tags to trigger generation."
        "\n- The system will process these tags and show the result to the user."
        "\n- HISTORY: You will see these tags in your history. This is normal. CONTINUING using them for new requests."
        "\n- Do NOT invent other formats like `[Audio:...]`."
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
            
            try:
                async for chunk in llm_service.chat_stream(
                    conversation_history,
                    chat_request.content,
                    system_prompt=system_prompt,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    enable_thinking=enable_thinking
                ):
                    content = chunk
                    
                    # Check for <think> tags to disable/enable marker checking
                    if "<think>" in content:
                        checking_for_marker = False
                        yield f"data: {json.dumps({'type': 'content', 'content': content})}\n\n"
                        full_response += content
                        continue
                    
                    if "</think>" in content:
                        checking_for_marker = True
                        yield f"data: {json.dumps({'type': 'content', 'content': content})}\n\n"
                        full_response += content
                        continue
                    
                    if not checking_for_marker:
                        yield f"data: {json.dumps({'type': 'content', 'content': content})}\n\n"
                        full_response += content
                        continue
                    
                    t2i_buffer += content
                    
                    # Check if buffer contains a potential marker start
                    # Updated to handle [Text to speak: hallucination
                    is_marker_potential = "[" in t2i_buffer
                    
                    # Check if we have a complete marker or if we should flush
                    # We should flush if the buffer gets too long without a marker, OR if it clearly doesn't validly start with one
                    # But we must be careful not to split [T2...
                    
                    has_marker = "[T2I_REQUEST:" in t2i_buffer or "[TTS_REQUEST:" in t2i_buffer or "[Text to speak:" in t2i_buffer
                    
                    if has_marker:
                        # We have a confirmed marker! Keep buffering until we find the closing bracket ]
                        if "]" in t2i_buffer:
                            # Process the command
                            full_param = t2i_buffer.strip()
                            
                            # --- T2I Handling ---
                            if "[T2I_REQUEST:" in full_param:
                                start_idx = full_param.find("[T2I_REQUEST:")
                                if start_idx != -1:
                                    prompt = full_param[start_idx + 13:].strip()
                                    if prompt.endswith("]"): prompt = prompt[:-1].strip()
                                    
                                    # Send progress update
                                    progress_msg = f"Generating image for: **{prompt}**..."
                                    yield f"data: {json.dumps({'type': 'content', 'content': progress_msg})}\n\n"
                                    
                                    # Call T2I Service
                                    t2i_service_inst = T2IService()
                                    try:
                                        # Check for annotation image in context
                                        ref_image_path = None
                                        if annotation_media_type == "image" and annotation_media_url:
                                             if "/api/files/" in annotation_media_url:
                                                # Extract local path from URL
                                                # URL format: .../api/files/{user_id}/{filename}
                                                import re
                                                match = re.search(r'/api/files/(\d+)/([^/]+)$', annotation_media_url)
                                                if match:
                                                    f_uid = match.group(1)
                                                    f_name = match.group(2)
                                                    # Need to find where uploads are stored. Using file_service logic.
                                                    # Assuming settings.UPLOAD_DIR
                                                    file_path = os.path.join(settings.UPLOAD_DIR, f_uid, f_name)
                                                    if os.path.exists(file_path):
                                                        ref_image_path = file_path

                                        # Generate
                                        # If we have a ref image, use img2img (controlled generation not fully impl yet, but let's pass it if service supports)
                                        # For now service.generate_image only takes prompt. 
                                        # We will stick to txt2img unless service updated.
                                        result = await t2i_service_inst.generate_image(prompt, current_user.id)
                                        
                                        # Send result
                                        yield f"data: {json.dumps({'type': 'image_generated', 'url': result['url'], 'prompt': prompt})}\n\n"
                                        # Save raw tag for LLM few-shot learning
                                        full_response = f"[T2I_REQUEST: {prompt}]"
                                        t2i_buffer = ""  # Clear buffer
                                        
                                    except Exception as e:
                                        err_msg = f"\n\nError generating image: {str(e)}"
                                        yield f"data: {json.dumps({'type': 'content', 'content': err_msg})}\n\n"
                                        full_response = f"Request: {prompt}\n{err_msg}"
                                else:
                                    yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                                    full_response += t2i_buffer
                            
                            # --- TTS Handling ---
                            elif "[TTS_REQUEST:" in full_param or "[Text to speak:" in full_param:
                                # Normalize marker
                                if "[TTS_REQUEST:" in full_param:
                                    prefix = "[TTS_REQUEST:"
                                else:
                                    prefix = "[Text to speak:"
                                    
                                start_idx = full_param.find(prefix)
                                if start_idx != -1:
                                    content_after = full_param[start_idx + len(prefix):].strip()
                                    if content_after.endswith("]"): content_after = content_after[:-1].strip()
                                    tts_text = content_after
                                    
                                    # Validate TTS text length to prevent API errors
                                    if len(tts_text.strip()) < 10:
                                        # Silent failure - don't show raw tags or error to user
                                        # Just clear buffer and continue without TTS
                                        full_response = ""  # Don't save raw tag to message
                                        t2i_buffer = ""
                                        continue
                                    
                                    if tts_text:
                                        progress_msg = f"Generating audio for: **{tts_text}**..."
                                        yield f"data: {json.dumps({'type': 'content', 'content': progress_msg})}\n\n"
                                    
                                    # Check for uploaded audio file to use as voice
                                    voice_path = None
                                    is_upload = False
                                    
                                    # 1. Check current request uploads
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
                                    
                                    # 2. Fallback: Check conversation history for consistent voice usage
                                    if not voice_path:
                                        for msg in reversed(conversation_history):
                                            if msg.get("role") == "user" and msg.get("media_type") == "audio" and msg.get("media_url"):
                                                 # Resolve path from history URL
                                                 item_url = msg["media_url"]
                                                 if "/api/files/" in item_url:
                                                     match = re.search(r'/api/files/(\d+)/([^/]+)$', item_url)
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
                                        # Save raw tag for LLM few-shot learning
                                        full_response = f"[TTS_REQUEST: {tts_text}]"
                                        t2i_buffer = ""  # Clear buffer after processing
                                    else:
                                        err_msg = f"\nFailed to generate audio: {result.get('error')}"
                                        yield f"data: {json.dumps({'type': 'content', 'content': err_msg})}\n\n"
                                        full_response = err_msg
                                        t2i_buffer = ""  # Clear buffer after processing
                                else:
                                    # Don't show raw tags to user
                                    full_response = ""
                                    t2i_buffer = ""
                            else:
                                 # Don't show raw tags to user
                                 full_response = ""
                                 t2i_buffer = ""
                        elif len(t2i_buffer) > 20 and not (t2i_buffer.strip().startswith("[T2I_REQUEST:") or t2i_buffer.strip().startswith("[TTS_REQUEST:") or t2i_buffer.strip().startswith("[Text to speak:")):
                            # Not a valid marker start
                             yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                             full_response += t2i_buffer
                             t2i_buffer = ""
                             # checking_for_marker = False # Keep checking? 
                             # If we flushed, we are likely just outputting text. But maybe marker appears LATER?
                             # Logic says: if we found a [ but it turned out not to be a marker, we flushed. 
                             # We should continue checking for NEW [
                             pass
                    elif is_marker_potential:
                        title_potential = True # Just wait for buffer to fill
                    else:
                         yield f"data: {json.dumps({'type': 'content', 'content': t2i_buffer})}\n\n"
                         full_response += t2i_buffer
                         t2i_buffer = ""
                         
                # End of loop - flush remaining buffer but filter out raw tags
                if t2i_buffer:
                    # Don't output raw T2I/TTS tags
                    if not ("[T2I_REQUEST:" in t2i_buffer or "[TTS_REQUEST:" in t2i_buffer or "[Text to speak:" in t2i_buffer):
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
                conversation.message_count = len(messages) + 2 # initial messages + user + assistant
                
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
