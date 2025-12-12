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
                        📋 Copy
                    </button>
                    ${!isUser ? `
                    <button class="message-action-btn" onclick="chatManager.speakMessage(this)" title="Speak">
                        🔊 Speak
                    </button>
                    ` : ''}
                    <button class="message-action-btn" onclick="chatManager.bookmarkMessage(this)" title="Bookmark">
                        ⭐ Bookmark
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
                `<video src="${file.preview}"></video>`
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
            <button class="new-chat-btn" onclick="chatManager.createNewChat()">
                <span>+</span> New Chat
            </button>
            
            <div class="conversation-list">
                ${this.conversations.map(conv => `
                    <button class="conversation-item ${this.currentConversation?.id === conv.id ? 'active' : ''}"
                            onclick="chatManager.selectConversation(${conv.id})"
                            oncontextmenu="chatManager.showContextMenu(event, ${conv.id})">
                        <span class="conversation-item-icon">💬</span>
                        <span class="conversation-item-title">${utils.escapeHtml(conv.title)}</span>
                    </button>
                `).join('')}
            </div>
        `;

        // Close context menu on global click
        document.addEventListener('click', () => this.hideContextMenu());
    }

    showContextMenu(event, conversationId) {
        event.preventDefault();
        this.hideContextMenu(); // Close any existing

        const menu = document.createElement('div');
        menu.id = 'context-menu';
        menu.className = 'context-menu';
        menu.innerHTML = `
            <button class="context-menu-item item-delete" onclick="chatManager.deleteConversation(${conversationId})">
                <span class="icon">🗑️</span> Delete Chat
            </button>
        `;

        // Position menu
        menu.style.left = `${event.pageX}px`;
        menu.style.top = `${event.pageY}px`;

        document.body.appendChild(menu);

        // slight animation
        requestAnimationFrame(() => menu.classList.add('active'));
    }

    hideContextMenu() {
        const menu = document.getElementById('context-menu');
        if (menu) menu.remove();
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
                            <span class="thinking-mode-icon">${thinkingMode === 'fast' ? '⚡' : thinkingMode === 'thinking' ? '🧠' : '🤖'}</span>
                            <span class="thinking-mode-label">TangLLM ${thinkingMode === 'fast' ? 'Fast' : thinkingMode === 'thinking' ? 'Thinking' : 'Auto'}</span>
                            <span class="thinking-mode-chevron">▼</span>
                        </button>
                        <div class="thinking-mode-menu" id="thinking-mode-menu">
                            <div class="thinking-mode-option ${thinkingMode === 'auto' ? 'active' : ''}" onclick="chatManager.setThinkingMode('auto')">
                                <span class="option-icon">🤖</span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Auto</span>
                                    <span class="option-desc">Automatically decides when to think</span>
                                </div>
                                ${thinkingMode === 'auto' ? '<span class="option-check">✓</span>' : ''}
                            </div>
                            <div class="thinking-mode-option ${thinkingMode === 'fast' ? 'active' : ''}" onclick="chatManager.setThinkingMode('fast')">
                                <span class="option-icon">⚡</span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Fast</span>
                                    <span class="option-desc">Quick responses, no deep thinking</span>
                                </div>
                                ${thinkingMode === 'fast' ? '<span class="option-check">✓</span>' : ''}
                            </div>
                            <div class="thinking-mode-option ${thinkingMode === 'thinking' ? 'active' : ''}" onclick="chatManager.setThinkingMode('thinking')">
                                <span class="option-icon">🧠</span>
                                <div class="option-content">
                                    <span class="option-title">TangLLM Thinking</span>
                                    <span class="option-desc">Extended reasoning for complex tasks</span>
                                </div>
                                ${thinkingMode === 'thinking' ? '<span class="option-check">✓</span>' : ''}
                            </div>
                        </div>
                    </div>
                    
                    <div class="welcome-logo">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2"/>
                        </svg>
                    </div>
                    <h1 class="welcome-title text-gradient">TangLLM</h1>
                    <p class="welcome-subtitle">How can I help you today?</p>
                    
                    <div class="welcome-suggestions">
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Explain quantum computing in simple terms')">
                            <div class="suggestion-icon">💡</div>
                            <div class="suggestion-title">Explain a concept</div>
                            <div class="suggestion-desc">Learn about complex topics</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Help me write a professional email')">
                            <div class="suggestion-icon">✍️</div>
                            <div class="suggestion-title">Write content</div>
                            <div class="suggestion-desc">Emails, essays, and more</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Analyze this image and describe what you see')">
                            <div class="suggestion-icon">🖼️</div>
                            <div class="suggestion-title">Analyze images</div>
                            <div class="suggestion-desc">Upload and analyze visuals</div>
                        </div>
                        <div class="suggestion-card" onclick="chatManager.useSuggestion('Review this code and suggest improvements')">
                            <div class="suggestion-icon">💻</div>
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
                                <span class="thinking-mode-icon">${thinkingMode === 'fast' ? '⚡' : thinkingMode === 'thinking' ? '🧠' : '🤖'}</span>
                                <span class="thinking-mode-label">TangLLM ${thinkingMode === 'fast' ? 'Fast' : thinkingMode === 'thinking' ? 'Thinking' : 'Auto'}</span>
                                <span class="thinking-mode-chevron">▼</span>
                            </button>
                            <div class="thinking-mode-menu" id="thinking-mode-menu">
                                <div class="thinking-mode-option ${thinkingMode === 'auto' ? 'active' : ''}" onclick="chatManager.setThinkingMode('auto')">
                                    <span class="option-icon">🤖</span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Auto</span>
                                        <span class="option-desc">Automatically decides when to think</span>
                                    </div>
                                    ${thinkingMode === 'auto' ? '<span class="option-check">✓</span>' : ''}
                                </div>
                                <div class="thinking-mode-option ${thinkingMode === 'fast' ? 'active' : ''}" onclick="chatManager.setThinkingMode('fast')">
                                    <span class="option-icon">⚡</span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Fast</span>
                                        <span class="option-desc">Quick responses, no deep thinking</span>
                                    </div>
                                    ${thinkingMode === 'fast' ? '<span class="option-check">✓</span>' : ''}
                                </div>
                                <div class="thinking-mode-option ${thinkingMode === 'thinking' ? 'active' : ''}" onclick="chatManager.setThinkingMode('thinking')">
                                    <span class="option-icon">🧠</span>
                                    <div class="option-content">
                                        <span class="option-title">TangLLM Thinking</span>
                                        <span class="option-desc">Extended reasoning for complex tasks</span>
                                    </div>
                                    ${thinkingMode === 'thinking' ? '<span class="option-check">✓</span>' : ''}
                                </div>
                            </div>
                        </div>
                        <h2 class="chat-title" id="chat-title">${utils.escapeHtml(this.currentConversation.title || 'New Chat')}</h2>
                    </div>
                    <div class="chat-actions">
                        <button class="btn btn-ghost btn-icon" onclick="chatManager.exportConversation('markdown')" title="Export">
                            📥
                        </button>
                        <button class="btn btn-ghost btn-icon" onclick="settingsManager.openSettings()" title="Settings">
                            ⚙️
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
                        ⚙️
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
                                📎
                            </button>
                            <button class="btn btn-ghost btn-icon" id="voice-btn" onclick="chatManager.toggleVoiceInput()" title="Voice input">
                                🎤
                            </button>
                            <input type="file" id="file-input" accept="image/*,video/*" multiple hidden 
                                   onchange="chatManager.handleFileUpload(this.files)">
                        </div>
                        
                        <textarea class="chat-input" id="chat-input" 
                                  placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
                                  rows="1"
                                  onkeydown="if(event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); chatManager.sendMessage(); }"></textarea>
                        
                        <button class="send-btn" id="send-btn" onclick="chatManager.sendMessage()" title="Send">
                            ➤
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
