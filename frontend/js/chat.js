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

        // Add text
        if (text) {
            content.push({
                type: 'text',
                text: text
            });
        }

        // Save files for UI before clearing
        const filesForUI = [...this.uploadedFiles];
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
        this.addMessageToUI('user', text, filesForUI);

        // Show typing indicator
        this.showTypingIndicator();

        this.isStreaming = true;
        this.updateSendButton();

        try {
            const stream = await api.sendMessageStream(content, this.currentConversation?.id);
            const reader = stream.getReader();
            const decoder = new TextDecoder();

            let fullResponse = '';
            let messageId = null;
            let conversationId = this.currentConversation?.id;

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
                        contentEl.innerHTML = utils.parseMarkdown(fullResponse);
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
                                    scheduleRender();
                                } else if (data.type === 'done') {
                                    messageId = data.message_id;
                                    conversationId = data.conversation_id;
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
            this.scrollToBottom();

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
            this.hideTypingIndicator();
            Toast.error(error.message || 'Failed to send message');
        } finally {
            this.isStreaming = false;
            this.updateSendButton();
        }
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

    showTypingIndicator() {
        const messagesContainer = document.getElementById('chat-messages');
        if (!messagesContainer) return;

        const indicator = utils.createElement('div', 'message message-assistant typing-message');
        indicator.id = 'typing-indicator';
        indicator.innerHTML = `
            <div class="avatar avatar-assistant">T</div>
            <div class="message-content">
                <div class="typing-indicator">
                    <span class="dot"></span>
                    <span class="dot"></span>
                    <span class="dot"></span>
                </div>
            </div>
        `;

        messagesContainer.appendChild(indicator);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    scrollToBottom() {
        const messagesContainer = document.getElementById('chat-messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    }

    updateSendButton() {
        const sendBtn = document.getElementById('send-btn');
        if (sendBtn) {
            sendBtn.disabled = this.isStreaming;
            sendBtn.innerHTML = this.isStreaming ?
                '<span class="spinner spinner-sm"></span>' :
                '➤';
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
            // Welcome screen
            chatContainer.innerHTML = `
                <div class="welcome-screen">
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
            // Chat view
            chatContainer.innerHTML = `
                <div class="chat-header">
                    <h2 class="chat-title">${utils.escapeHtml(this.currentConversation.title)}</h2>
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
}

// Create global chat manager
window.chatManager = new ChatManager();
