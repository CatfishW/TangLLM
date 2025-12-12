/**
 * TangLLM Chat Module
 * Main chat functionality with streaming support
 */

class ChatManager {
    constructor() {
        this.currentConversation = null;
        this.conversations = [];
        this.isStreaming = false;
        this.uploadedFiles = [];
        this.voiceInput = new VoiceInput();
        this.voiceOutput = new VoiceOutput();
        this.abortController = null;  // For canceling streaming requests
        this.streamReader = null;  // For canceling stream reader
    }

    async init() {
        await this.loadConversations();
        this.setupVoice();
    }

    setupVoice() {
        this.voiceInput.onResult = (transcript, isFinal) => {
            const input = document.getElementById('chat-input');
            if (input) {
                input.value = transcript;
                if (isFinal) {
                    // Auto-send when voice input is complete
                    // this.sendMessage();
                }
            }
        };

        this.voiceInput.onEnd = () => {
            const voiceBtn = document.getElementById('voice-btn');
            if (voiceBtn) {
                voiceBtn.classList.remove('active');
            }
        };
    }

    async loadConversations() {
        try {
            this.conversations = await api.getConversations();
        } catch (error) {
            console.error('Failed to load conversations:', error);
            this.conversations = [];
        }
    }

    async selectConversation(conversationId) {
        if (!conversationId) {
            this.currentConversation = null;
            this.renderChat();
            return;
        }

        try {
            this.currentConversation = await api.getConversation(conversationId);
            this.renderChat();
        } catch (error) {
            Toast.error('Failed to load conversation');
        }
    }

    async createNewChat() {
        this.currentConversation = null;
        this.uploadedFiles = [];
        this.renderChat();
    }

    async deleteConversation(conversationId) {
        try {
            await api.deleteConversation(conversationId);
            await this.loadConversations();

            if (this.currentConversation?.id === conversationId) {
                this.currentConversation = null;
            }

            this.renderSidebar();
            this.renderChat();
            Toast.success('Conversation deleted');
        } catch (error) {
            Toast.error('Failed to delete conversation');
        }
    }

    async sendMessage() {
        const input = document.getElementById('chat-input');
        const text = input?.value.trim();

        if (!text && this.uploadedFiles.length === 0) return;
        if (this.isStreaming) return;

        // Build message content
        const content = [];

        // Add files
        for (const file of this.uploadedFiles) {
            content.push({
                type: file.type,
                url: file.url
            });
        }

        // Detect and extract URLs from text (for images and videos)
        let textWithoutUrls = text;
        if (text) {
            // Regex to match URLs
            const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
            const imageExtensions = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i;
            const videoExtensions = /\.(mp4|webm|ogg|mov|avi|mkv)(\?.*)?$/i;

            const urls = text.match(urlRegex) || [];

            for (const url of urls) {
                if (imageExtensions.test(url)) {
                    content.push({
                        type: 'image',
                        url: url
                    });
                    // Remove URL from text to avoid duplication
                    textWithoutUrls = textWithoutUrls.replace(url, '').trim();
                } else if (videoExtensions.test(url)) {
                    content.push({
                        type: 'video',
                        url: url
                    });
                    textWithoutUrls = textWithoutUrls.replace(url, '').trim();
                }
            }
        }

        // Add remaining text (after removing extracted URLs)
        if (textWithoutUrls) {
            content.push({
                type: 'text',
                text: textWithoutUrls
            });
        }

        // Save files for UI before clearing (includes detected URL media)
        const filesForUI = [...this.uploadedFiles];

        // Add URL-detected media to files for UI display
        for (const item of content) {
            if ((item.type === 'image' || item.type === 'video') &&
                item.url && item.url.startsWith('http') &&
                !filesForUI.some(f => f.url === item.url)) {
                filesForUI.push({
                    type: item.type,
                    url: item.url,
                    preview: item.url,
                    name: 'URL Media'
                });
            }
        }

        this.uploadedFiles = [];

        // If we're on the welcome screen (no chat-messages container), switch to chat view first
        if (!document.getElementById('chat-messages')) {
            this.renderChatView();
        }

        // Now clear the new input (after potential re-render)
        const newInput = document.getElementById('chat-input');
        if (newInput) newInput.value = '';
        this.renderFilePreview();

        // Add user message to UI
        this.addMessageToUI('user', textWithoutUrls || text, filesForUI);

        // Show typing indicator
        this.showTypingIndicator();

        this.isStreaming = true;
        this.abortController = new AbortController();
        this.updateSendButton();

        try {
            const stream = await api.sendMessageStream(content, this.currentConversation?.id, this.abortController.signal);
            const reader = stream.getReader();
            this.streamReader = reader;  // Store reference for cancellation
            const decoder = new TextDecoder();

            let fullResponse = '';
            let messageId = null;
            let conversationId = this.currentConversation?.id;
            let annotationUrl = null;

            // Create assistant message element
            const messageEl = this.addMessageToUI('assistant', '', []);
            if (!messageEl) {
                this.hideTypingIndicator();
                return;
            }
            const contentEl = messageEl.querySelector('.message-text');

            // Hide typing indicator
            this.hideTypingIndicator();

            let buffer = ''; // Buffer for incomplete lines

            // Tracking for thinking state
            let isThinking = false;
            let thinkingClosed = false;

            // Throttled rendering - only update DOM at most every 50ms (20fps)
            // This prevents main thread blocking during fast streaming of long responses
            let renderPending = false;
            let lastRenderTime = 0;
            let lastRenderedContentLength = 0;
            const RENDER_THROTTLE_MS = 50;

            const scheduleRender = () => {
                // Optimization: don't schedule if nothing new to render
                if (fullResponse.length === lastRenderedContentLength) return;

                if (renderPending) return;
                const now = performance.now();
                const timeSinceLastRender = now - lastRenderTime;

                const render = () => {
                    // Double check content changed (it might have been rendered by a forced flush)
                    if (fullResponse.length !== lastRenderedContentLength) {
                        // Preserve thinking toggle state before re-render
                        const existingToggle = contentEl.querySelector('.thinking-toggle');
                        const wasOpen = existingToggle?.open || false;

                        contentEl.innerHTML = utils.parseMarkdown(fullResponse);

                        // Restore thinking toggle state after re-render
                        const newToggle = contentEl.querySelector('.thinking-toggle');
                        if (newToggle && wasOpen) {
                            newToggle.open = true;
                        }

                        this.scrollToBottom();
                        lastRenderTime = performance.now();
                        lastRenderedContentLength = fullResponse.length;
                    }
                    renderPending = false;
                };

                if (timeSinceLastRender >= RENDER_THROTTLE_MS) {
                    render();
                } else {
                    renderPending = true;
                    // Use setTimeout to ensure we respect the throttle time, 
                    // requestAnimationFrame causes it to try to catch up too aggressively sometimes
                    setTimeout(render, RENDER_THROTTLE_MS - timeSinceLastRender);
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Decode with stream: true to handle partial UTF-8 sequences
                buffer += decoder.decode(value, { stream: true });

                // Split by double newlines (SSE event separator)
                const events = buffer.split('\n\n');

                // Keep the last part in buffer if it doesn't end with \n\n
                buffer = events.pop() || '';

                for (const event of events) {
                    const lines = event.split('\n');
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(line.slice(6));

                                if (data.type === 'content') {
                                    fullResponse += data.content;

                                    // Detect thinking state from <think> tags
                                    if (!thinkingClosed) {
                                        if (fullResponse.includes('<think') && !isThinking) {
                                            isThinking = true;
                                            this.showTypingIndicator(true);
                                        }
                                        if (fullResponse.includes('</think>')) {
                                            isThinking = false;
                                            thinkingClosed = true;
                                            this.hideTypingIndicator();
                                        }
                                    }

                                    scheduleRender();
                                } else if (data.type === 'annotation') {
                                    // Received annotated detection image
                                    annotationUrl = data.url;
                                } else if (data.type === 'image_generated') {
                                    // Received generated image
                                    const grid = messageEl.querySelector('.generated-images-grid');
                                    if (grid) {
                                        grid.innerHTML += `
                                            <div class="generated-image-wrapper">
                                                <img src="${data.url}" alt="${data.prompt}" class="generated-image" onclick="window.open('${data.url}', '_blank')">
                                                <div class="image-actions-overlay">
                                                    <a href="${data.url}" download class="image-overlay-btn" title="Download">⬇</a>
                                                </div>
                                            </div>
                                        `;
                                    }
                                } else if (data.type === 'audio_generated') {
                                    try {
                                        let audioFn = messageEl.querySelector('.audio-container');
                                        if (!audioFn) {
                                            audioFn = document.createElement('div');
                                            audioFn.className = 'audio-container';

                                            const actions = messageEl.querySelector('.message-actions');
                                            if (actions && actions.parentNode) {
                                                actions.parentNode.insertBefore(audioFn, actions);
                                            } else {
                                                const contentWrapper = messageEl.querySelector('.message-text')?.parentNode || messageEl;
                                                contentWrapper.appendChild(audioFn);
                                            }
                                        }

                                        const safeText = (data.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                                        const shortText = safeText.length > 50 ? safeText.substring(0, 50) + '...' : safeText;

                                        audioFn.innerHTML += `
                                            <div class="generated-audio-wrapper">
                                                <div class="audio-label">🔊 ${shortText}</div>
                                                <audio controls src="${data.url}" class="generated-audio"></audio>
                                            </div>
                                        `;
                                    } catch (e) { console.error("Audio render error:", e); }
                                } else if (data.type === 'done') {
                                    messageId = data.message_id;
                                    conversationId = data.conversation_id;
                                    // Update conversation title in sidebar if we got a new one
                                    if (data.title && this.currentConversationId) {
                                        this.updateConversationTitle(this.currentConversationId, data.title);
                                    }
                                } else if (data.type === 'error') {
                                    Toast.error(data.error);
                                }
                            } catch (e) {
                                console.warn('SSE parse error:', e, 'line:', line);
                            }
                        }
                    }
                }
            }

            // Final render to ensure all content is displayed
            contentEl.innerHTML = utils.parseMarkdown(fullResponse);

            // Append annotated image if present
            if (annotationUrl) {
                const annotationHtml = `
                    <div class="annotation-result">
                        <div class="annotation-header">
                            <span class="annotation-icon">🎯</span>
                            <span class="annotation-label">Detected Objects</span>
                        </div>
                        <div class="annotation-image">
                            <img src="${annotationUrl}" alt="Annotated detection result" onclick="window.open('${annotationUrl}', '_blank')">
                        </div>
                    </div>
                `;
                contentEl.innerHTML += annotationHtml;
            }

            this.scrollToBottom();

            // Hide typing indicator after generation completes
            this.hideTypingIndicator();

            // Handle any remaining data in buffer
            if (buffer.trim()) {
                const lines = buffer.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.type === 'content') {
                                fullResponse += data.content;
                                contentEl.innerHTML = utils.parseMarkdown(fullResponse);
                            } else if (data.type === 'done') {
                                messageId = data.message_id;
                                conversationId = data.conversation_id;
                            }
                        } catch (e) {
                            // Ignore
                        }
                    }
                }
            }

            // Update conversation
            if (conversationId && !this.currentConversation) {
                // New conversation was created
                await this.loadConversations();
                this.currentConversation = { id: conversationId };
                this.renderSidebar();
            }

            // Enable voice output for response
            if (this.voiceOutput.isSupported() && fullResponse) {
                // Could auto-play, but let user click
            }

        } catch (error) {
            // Ignore abort errors - they are expected when user cancels
            if (error.name !== 'AbortError') {
                this.hideTypingIndicator();
                Toast.error(error.message || 'Failed to send message');
            }
        } finally {
            this.isStreaming = false;
            this.abortController = null;
            this.streamReader = null;
            this.updateSendButton();
        }
    }

    cancelRequest() {
        // Cancel the stream reader first
        if (this.streamReader) {
            this.streamReader.cancel().catch(() => { });
            this.streamReader = null;
        }
        // Then abort the fetch request
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isStreaming = false;
        this.updateSendButton();
        this.hideTypingIndicator();
        Toast.info('Generation stopped');
    }

    addMessageToUI(role, text, files = []) {
        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) return null;

        const isUser = role === 'user';
        const avatar = isUser ? authManager.getUser()?.username?.[0] || 'U' : 'T';

        const messageEl = utils.createElement('div', `message message-${role}`);

        let mediaHtml = '';
        if (files && files.length > 0) {
            mediaHtml = files.map(file => {
                if (file.type === 'image') {
                    return `<div class="message-media"><img src="${file.url}" alt="Uploaded image"></div>`;
                } else if (file.type === 'video') {
                    return `<div class="message-media"><video src="${file.url}" controls></video></div>`;
                } else if (file.type === 'audio') {
                    return `
                    <div class="message-media" style="width: 100%; max-width: 400px;">
                        <div class="generated-audio-wrapper">
                            <div class="audio-label" style="font-size: 0.8em; margin-bottom: 4px; opacity: 0.8;">Uploaded: ${utils.escapeHtml(file.name || 'Audio')}</div>
                            <audio src="${file.url}" controls class="generated-audio" style="width: 100%;"></audio>
                        </div>
                    </div>`;
                }
                return '';
            }).join('');
        }

        messageEl.innerHTML = `
            <div class="avatar avatar-${role}">${avatar}</div>
            <div class="message-content">
                ${mediaHtml}
                <div class="message-text">${text ? utils.parseMarkdown(text) : ''}</div>
                <div class="generated-images-grid"></div>
                <div class="message-actions">
                    <button class="message-action-btn" onclick="chatManager.copyMessage(this)" title="Copy">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                    </button>
                    ${!isUser ? `
                    <button class="message-action-btn" onclick="chatManager.speakMessage(this)" title="Speak">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        </svg>
                    </button>
                    <button class="message-action-btn" onclick="chatManager.regenerateMessage(this)" title="Regenerate">
                         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"></polyline>
                            <polyline points="1 20 1 14 7 14"></polyline>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                    </button>
                    ` : ''}
                    <button class="message-action-btn" onclick="chatManager.bookmarkMessage(this)" title="Bookmark">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                           <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        messagesContainer.appendChild(messageEl);
        this.scrollToBottom();

        return messageEl;
    }

    showTypingIndicator(isThinking = false) {
        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) return;

        // Remove existing indicator if any
        this.hideTypingIndicator();

        const indicator = utils.createElement('div', 'message message-assistant typing-message');
        indicator.id = 'typing-indicator';
        indicator.innerHTML = `
            <div class="avatar avatar-assistant">T</div>
            <div class="message-content">
                <div class="typing-indicator ${isThinking ? 'thinking-mode' : ''}">
                    ${isThinking ? '<span class="thinking-text">🧠 Thinking...</span>' : ''}
                    <span class="dot"></span>
                    <span class="dot"></span>
                    <span class="dot"></span>
                </div>
            </div>
        `;

        messagesContainer.appendChild(indicator);
        this.scrollToBottom();
    }

    updateTypingIndicator(isThinking) {
        const indicator = document.getElementById('typing-indicator');
        if (!indicator) return;

        const typingDiv = indicator.querySelector('.typing-indicator');
        if (typingDiv) {
            typingDiv.classList.toggle('thinking-mode', isThinking);

            // Update the text
            let thinkingText = typingDiv.querySelector('.thinking-text');
            if (isThinking && !thinkingText) {
                thinkingText = document.createElement('span');
                thinkingText.className = 'thinking-text';
                thinkingText.textContent = '🧠 Thinking...';
                typingDiv.insertBefore(thinkingText, typingDiv.firstChild);
            } else if (!isThinking && thinkingText) {
                thinkingText.remove();
            }
        }
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    updateConversationTitle(conversationId, newTitle) {
        // Update in the conversations array
        const conv = this.conversations.find(c => c.id === conversationId);
        if (conv) {
            conv.title = newTitle;
        }

        // Update the sidebar item
        const sidebarItems = document.querySelectorAll('.conversation-item');
        sidebarItems.forEach(item => {
            const onclick = item.getAttribute('onclick');
            if (onclick && onclick.includes(`selectConversation(${conversationId})`)) {
                const titleEl = item.querySelector('.conversation-item-title');
                if (titleEl) {
                    titleEl.textContent = newTitle;
                }
            }
        });

        // Update the chat header if this is the current conversation
        if (this.currentConversation?.id === conversationId) {
            this.currentConversation.title = newTitle;
            const chatTitle = document.getElementById('chat-title');
            if (chatTitle) {
                chatTitle.textContent = newTitle;
            }
        }
    }

    scrollToBottom() {
        const messagesContainer = document.getElementById('chat-messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    updateSendButton() {
        const sendBtn = document.getElementById('send-btn');
        const cancelContainer = document.getElementById('cancel-request-container');

        if (sendBtn) {
            sendBtn.disabled = this.isStreaming;
            sendBtn.innerHTML = this.isStreaming ?
                '<span class="spinner spinner-sm"></span>' :
                '➤';
        }

        if (cancelContainer) {
            cancelContainer.style.display = this.isStreaming ? 'flex' : 'none';
        }
    }

    // ============= File Upload =============

    async handleFileUpload(files) {
        for (const file of files) {
            try {
                const result = await api.uploadFile(file);
                const preview = await utils.createFilePreview(file);

                this.uploadedFiles.push({
                    type: result.media_type,
                    url: result.url,
                    preview: preview.url,
                    name: file.name
                });

                this.renderFilePreview();
            } catch (error) {
                Toast.error(`Failed to upload ${file.name}`);
            }
        }
    }

    removeFile(index) {
        this.uploadedFiles.splice(index, 1);
        this.renderFilePreview();
    }

    renderFilePreview() {
        const container = document.getElementById('file-preview');
        if (!container) return;

        if (this.uploadedFiles.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }

        container.style.display = 'flex';
        container.innerHTML = this.uploadedFiles.map((file, index) => `
            <div class="file-preview-item">
                ${file.type === 'image' ?
                `<img src="${file.preview}" alt="${file.name}">` :
                (file.type === 'video' ? `<video src="${file.preview}"></video>` :
                    `<div class="audio-preview-icon" title="${file.name}">🎵</div>`)
            }
                <button class="file-preview-remove" onclick="chatManager.removeFile(${index})">×</button>
            </div>
        `).join('');
    }

    // ============= Message Actions =============

    copyMessage(btn) {
        const text = btn.closest('.message-content').querySelector('.message-text').textContent;
        navigator.clipboard.writeText(text);
        Toast.success('Copied to clipboard');
    }

    speakMessage(btn) {
        const text = btn.closest('.message-content').querySelector('.message-text').textContent;
        if (this.voiceOutput.isSpeaking) {
            this.voiceOutput.stop();
            btn.textContent = '🔊 Speak';
        } else {
            this.voiceOutput.speak(text);
            btn.textContent = '⏹ Stop';
        }
    }

    bookmarkMessage(btn) {
        // Toggle bookmark UI
        const isBookmarked = btn.classList.toggle('active');
        btn.textContent = isBookmarked ? '⭐ Bookmarked' : '⭐ Bookmark';
        Toast.success(isBookmarked ? 'Message bookmarked' : 'Bookmark removed');
    }

    // ============= Voice =============

    toggleVoiceInput() {
        const voiceBtn = document.getElementById('voice-btn');

        if (this.voiceInput.isListening) {
            this.voiceInput.stop();
            voiceBtn?.classList.remove('active');
        } else {
            if (this.voiceInput.start()) {
                voiceBtn?.classList.add('active');
                Toast.info('Listening...');
            } else {
                Toast.error('Voice input not supported');
            }
        }
    }

    // ============= Export =============

    async exportConversation(format = 'markdown') {
        if (!this.currentConversation) return;

        try {
            const result = await api.exportConversation(this.currentConversation.id, format);

            // Download file
            const blob = new Blob(
                [format === 'json' ? JSON.stringify(result.content, null, 2) : result.content],
                { type: format === 'json' ? 'application/json' : 'text/markdown' }
            );

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `conversation.${format === 'json' ? 'json' : 'md'}`;
            a.click();

            URL.revokeObjectURL(url);
            Toast.success('Conversation exported');
        } catch (error) {
            Toast.error('Failed to export conversation');
        }
    }

    // ============= Render Methods =============

    renderSidebar() {
        const sidebarContent = document.getElementById('sidebar-content');
        if (!sidebarContent) return;

        sidebarContent.innerHTML = `
            <div style="padding: 0 var(--space-4);">
                <button class="new-chat-btn" onclick="chatManager.createNewChat()">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    New Chat
                </button>
            </div>
            
            <div class="conversation-list">
                ${this.conversations.map(conv => `
                    <div class="conversation-item-wrapper">
                        <button class="conversation-item ${this.currentConversation?.id === conv.id ? 'active' : ''}"
                                onclick="chatManager.selectConversation(${conv.id})">
                            <span class="conversation-item-title">${utils.escapeHtml(conv.title)}</span>
                        </button>
                        <div class="conversation-menu dropdown">
                            <button class="conversation-menu-btn" onclick="chatManager.toggleContextMenu(event, ${conv.id})">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="1"></circle>
                                    <circle cx="12" cy="5" r="1"></circle>
                                    <circle cx="12" cy="19" r="1"></circle>
                                </svg>
                            </button>
                            <div class="dropdown-menu" id="ctx-menu-${conv.id}">
                                <button class="dropdown-item item-delete" onclick="chatManager.deleteConversation(${conv.id})">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                                        <polyline points="3 6 5 6 21 6"></polyline>
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                    </svg>
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>

        `;
    }

    toggleContextMenu(event, conversationId) {
        event.stopPropagation();
        // Close all other menus
        document.querySelectorAll('.conversation-menu.active').forEach(el => {
            if (el.querySelector(`#ctx-menu-${conversationId}`) === null) {
                el.classList.remove('active');
            }
        });

        const btn = event.currentTarget;
        const menuWrapper = btn.closest('.conversation-menu');
        menuWrapper.classList.toggle('active');

        // Global click handler to close menus
        const closeHandler = (e) => {
            if (!menuWrapper.contains(e.target)) {
                menuWrapper.classList.remove('active');
                document.removeEventListener('click', closeHandler);
            }
        };

        if (menuWrapper.classList.contains('active')) {
            // Delay adding listener to avoid immediate trigger
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        }
    }

    async clearAllHistory() {
        if (!confirm('Are you sure you want to delete ALL chat history? This cannot be undone.')) return;

        try {
            await api.deleteAllConversations();
            await this.loadConversations();
            this.createNewChat();
            Toast.success('All history cleared');
        } catch (error) {
            Toast.error('Failed to clear history');
        }
    }

    renderChat() {
        const chatContainer = document.getElementById('chat-container');
        if (!chatContainer) return;

        if (!this.currentConversation) {
            // Welcome screen - get thinking mode from settings or localStorage
            const thinkingMode = settingsManager.settings?.thinking_mode || localStorage.getItem('thinkingMode') || 'auto';
            chatContainer.innerHTML = `
                <div class="welcome-screen">
                    <div class="thinking-mode-selector welcome-mode-selector" id="thinking-mode-selector">
                        <button class="thinking-mode-btn" onclick="chatManager.toggleThinkingModeMenu()">
                            <span class="thinking-mode-icon">
                                ${thinkingMode === 'fast' ?
                    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>` :
                    thinkingMode === 'thinking' ?
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>` :
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>`
                }
                            </span>
                            <span class="thinking-mode-label">TangLLM ${thinkingMode === 'fast' ? 'Fast' : thinkingMode === 'thinking' ? 'Thinking' : 'Auto'}</span>
                            <span class="thinking-mode-chevron">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                            </span>
                        </button>
                        <div class="thinking-mode-menu" id="thinking-mode-menu">
                            <div class="thinking-mode-option ${thinkingMode === 'auto' ? 'active' : ''}" onclick="chatManager.setThinkingMode('auto')">
                                <span class="option-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
                                </span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Auto</span>
                                    <span class="option-desc">Automatically decides when to think</span>
                                </div>
                                ${thinkingMode === 'auto' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                            </div>
                            <div class="thinking-mode-option ${thinkingMode === 'fast' ? 'active' : ''}" onclick="chatManager.setThinkingMode('fast')">
                                <span class="option-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                                </span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Fast</span>
                                    <span class="option-desc">Quick responses, no deep thinking</span>
                                </div>
                                ${thinkingMode === 'fast' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                            </div>
                            <div class="thinking-mode-option ${thinkingMode === 'thinking' ? 'active' : ''}" onclick="chatManager.setThinkingMode('thinking')">
                                <span class="option-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-4A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-4A2.5 2.5 0 0 0 14.5 2Z"/></svg>
                                </span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Thinking</span>
                                    <span class="option-desc">Extended reasoning for complex tasks</span>
                                </div>
                                ${thinkingMode === 'thinking' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div class="welcome-logo" style="background: none; width: auto; height: auto;">
                        <div class="logo-badge" style="padding: 12px 20px; border-radius: 12px;">
                            <img src="assets/rowan-logo.png" alt="Rowan University" style="height: 60px; width: auto;">
                        </div>
                    </div>
                    <p class="welcome-subtitle">How can I help you today?</p>
                    
                    <div class="welcome-suggestions">
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Explain quantum computing in simple terms')">
                            <div class="suggestion-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M15.09 14c.18-.9.66-1.74 1.41-2.33A4.5 4.5 0 0 0 10 5c-3 0-5.32 2.87-4.5 5.92.54 2 2.22 3.6 4.3 4.08"></path></svg>
                            </div>
                            <div class="suggestion-title">Explain a concept</div>
                            <div class="suggestion-desc">Learn about complex topics</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Help me write a professional email')">
                            <div class="suggestion-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>
                            </div>
                            <div class="suggestion-title">Write content</div>
                            <div class="suggestion-desc">Emails, essays, and more</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Analyze this image and describe what you see')">
                            <div class="suggestion-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
                            </div>
                            <div class="suggestion-title">Analyze images</div>
                            <div class="suggestion-desc">Upload and analyze visuals</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Review this code and suggest improvements')">
                            <div class="suggestion-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>
                            </div>
                            <div class="suggestion-title">Code assistance</div>
                            <div class="suggestion-desc">Debug and improve code</div>
                        </div>
                    </div>
                </div>
                
                ${this.renderChatInput()}
            `;
        } else {
            // Chat view - get thinking mode from settings (database) or localStorage fallback
            const thinkingMode = settingsManager.settings?.thinking_mode || localStorage.getItem('thinkingMode') || 'auto';
            chatContainer.innerHTML = `
                <div class="chat-header">
                    <div class="chat-header-left">
                        <div class="thinking-mode-selector" id="thinking-mode-selector">
                            <button class="thinking-mode-btn" onclick="chatManager.toggleThinkingModeMenu()">
                                <span class="thinking-mode-icon">
                                    ${thinkingMode === 'fast' ?
                    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>` :
                    thinkingMode === 'thinking' ?
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-4A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-4A2.5 2.5 0 0 0 14.5 2Z"/></svg>` :
                        `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>`
                }
                                </span>
                                <span class="thinking-mode-label">TangLLM ${thinkingMode === 'fast' ? 'Fast' : thinkingMode === 'thinking' ? 'Thinking' : 'Auto'}</span>
                                <span class="thinking-mode-chevron">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                                </span>
                            </button>
                            <div class="thinking-mode-menu" id="thinking-mode-menu">
                                <div class="thinking-mode-option ${thinkingMode === 'auto' ? 'active' : ''}" onclick="chatManager.setThinkingMode('auto')">
                                    <span class="option-icon">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>
                                    </span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Auto</span>
                                        <span class="option-desc">Automatically decides when to think</span>
                                    </div>
                                    ${thinkingMode === 'auto' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                                </div>
                                <div class="thinking-mode-option ${thinkingMode === 'fast' ? 'active' : ''}" onclick="chatManager.setThinkingMode('fast')">
                                    <span class="option-icon">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>
                                    </span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Fast</span>
                                        <span class="option-desc">Quick responses, no deep thinking</span>
                                    </div>
                                    ${thinkingMode === 'fast' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                                </div>
                                <div class="thinking-mode-option ${thinkingMode === 'thinking' ? 'active' : ''}" onclick="chatManager.setThinkingMode('thinking')">
                                    <span class="option-icon">
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>
                                    </span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Thinking</span>
                                        <span class="option-desc">Extended reasoning for complex tasks</span>
                                    </div>
                                    ${thinkingMode === 'thinking' ? '<span class="option-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' : ''}
                                </div>
                            </div>
                        </div>
                        <h2 class="chat-title" id="chat-title">${utils.escapeHtml(this.currentConversation.title || 'New Chat')}</h2>
                    </div>
                    <div class="chat-actions">
                        <button class="btn btn-ghost btn-icon" onclick="chatManager.exportConversation('markdown')" title="Export">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                        </button>
                        <button class="btn btn-ghost btn-icon" onclick="settingsManager.openSettings()" title="Settings">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                        </button>
                    </div>
                </div>
                
                <div class="chat-messages" id="chat-messages">
                    ${this.currentConversation.messages?.map(msg => this.renderMessage(msg)).join('') || ''}
                </div>
                
                ${this.renderChatInput()}
            `;

            this.scrollToBottom();
        }
    }

    // Render a chat view for a new conversation (before it's created on server)
    renderChatView() {
        const chatContainer = document.getElementById('chat-container');
        if (!chatContainer) return;

        chatContainer.innerHTML = `
            <div class="chat-header">
                <h2 class="chat-title">New Chat</h2>
                <div class="chat-actions">
                    <button class="btn btn-ghost btn-icon" onclick="settingsManager.openSettings()" title="Settings">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
                    </button>
                </div>
            </div>
            
            <div class="chat-messages" id="chat-messages">
            </div>
            
            ${this.renderChatInput()}
        `;
    }

    renderMessage(msg) {
        const isUser = msg.role === 'user';
        const avatar = isUser ? authManager.getUser()?.username?.[0] || 'U' : 'T';

        let mediaHtml = '';
        if (msg.media_url) {
            if (msg.media_type === 'image') {
                mediaHtml = `<div class="message-media"><img src="${msg.media_url}" alt="Image" onerror="this.parentElement.innerHTML='<span class=\\'media-error\\'>📷 Image unavailable</span>'"></div>`;
            } else if (msg.media_type === 'video') {
                mediaHtml = `<div class="message-media"><video src="${msg.media_url}" controls onerror="this.parentElement.innerHTML='<span class=\\'media-error\\'>🎬 Video unavailable</span>'"></video></div>`;
            }
        }

        return `
            <div class="message message-${msg.role}">
                <div class="avatar avatar-${msg.role}">${avatar}</div>
                <div class="message-content">
                    ${mediaHtml}
                    <div class="message-text">${utils.parseMarkdown(msg.content || '')}</div>
                    <div class="message-actions">
                        <button class="message-action-btn" onclick="chatManager.copyMessage(this)" title="Copy">
                            📋 Copy
                        </button>
                        ${!isUser ? `
                        <button class="message-action-btn" onclick="chatManager.speakMessage(this)" title="Speak">
                            🔊 Speak
                        </button>
                        ` : ''}
                        <button class="message-action-btn ${msg.is_bookmarked ? 'active' : ''}" onclick="chatManager.bookmarkMessage(this)" title="Bookmark">
                            ⭐ ${msg.is_bookmarked ? 'Bookmarked' : 'Bookmark'}
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    renderChatInput() {
        return `
            <div class="chat-input-container">
                <div class="cancel-request-container" id="cancel-request-container" style="display: none;">
                    <button class="cancel-request-btn" id="cancel-request-btn" onclick="chatManager.cancelRequest()">
                        <span class="cancel-icon">⏹</span>
                        <span>Stop generating</span>
                    </button>
                </div>
                
                <div class="chat-input-wrapper">
                    <div class="file-preview" id="file-preview" style="display: none;"></div>
                    
                    <div class="chat-input-row">
                        <div class="chat-input-actions">
                            <button class="btn btn-ghost btn-icon" onclick="document.getElementById('file-input').click()" title="Upload file">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
                                </svg>
                            </button>
                            <button class="btn btn-ghost btn-icon" id="voice-btn" onclick="chatManager.toggleVoiceInput()" title="Voice input">
                                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M4 10V14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M8 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M12 4V20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M16 7V17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                    <path d="M20 10V14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                </svg>
                            </button>
                            <input type="file" id="file-input" accept="image/*,video/*,audio/*,.wav,.mp3,.ogg,.m4a" multiple hidden 
                                   onchange="chatManager.handleFileUpload(this.files)">
                        </div>
                        
                        <textarea class="chat-input" id="chat-input" 
                                  placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                                  rows="1"
                                  onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); chatManager.sendMessage(); }"></textarea>
                        
                        <button class="send-btn" id="send-btn" onclick="chatManager.sendMessage()" title="Send">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="22" y1="2" x2="11" y2="13"></line>
                                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                            </svg>
                        </button>
                    </div>
                </div>
                
                <p style="text-align: center; margin-top: var(--space-2); font-size: var(--text-xs); color: var(--color-text-muted);">
                    Powered by Qwen3-VL • TangLLM v1.0
                </p>
            </div>
        `;
    }

    useSuggestion(text) {
        const input = document.getElementById('chat-input');
        if (input) {
            input.value = text;
            input.focus();
        }
    }

    setThinkingMode(mode) {
        // Update localStorage immediately for instant UI feedback
        localStorage.setItem('thinkingMode', mode);

        // Also update settingsManager immediately so renderChat gets the new value
        if (settingsManager.settings) {
            settingsManager.settings.thinking_mode = mode;
        }

        // Save to database via API (async, no need to wait)
        api.updateSettings({ thinking_mode: mode }).catch(err =>
            console.warn('Failed to save thinking mode to DB:', err)
        );

        const modeNames = { auto: 'Auto', fast: 'Fast', thinking: 'Thinking' };
        Toast.success(`Switched to TangLLM ${modeNames[mode]}`);

        // Close menu and re-render to update UI
        this.closeThinkingModeMenu();
        this.renderChat();
    }

    toggleThinkingModeMenu() {
        const menu = document.getElementById('thinking-mode-menu');
        if (menu) {
            menu.classList.toggle('show');

            // Close on outside click
            if (menu.classList.contains('show')) {
                setTimeout(() => {
                    document.addEventListener('click', this.closeThinkingModeMenuHandler);
                }, 0);
            }
        }
    }

    closeThinkingModeMenu() {
        const menu = document.getElementById('thinking-mode-menu');
        if (menu) {
            menu.classList.remove('show');
        }
        document.removeEventListener('click', this.closeThinkingModeMenuHandler);
    }

    closeThinkingModeMenuHandler = (e) => {
        const selector = document.getElementById('thinking-mode-selector');
        if (selector && !selector.contains(e.target)) {
            this.closeThinkingModeMenu();
        }
    }

    getThinkingMode() {
        return settingsManager.settings?.thinking_mode || localStorage.getItem('thinkingMode') || 'auto';
    }
}

// Create global chat manager
window.chatManager = new ChatManager();
