/**
 * TangLLM Utilities
 * Helper functions and utilities
 */

// ============= DOM Utilities =============

function $(selector, parent = document) {
    return parent.querySelector(selector);
}

function $$(selector, parent = document) {
    return Array.from(parent.querySelectorAll(selector));
}

function createElement(tag, className = '', innerHTML = '') {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (innerHTML) el.innerHTML = innerHTML;
    return el;
}

// ============= Animation Utilities =============

function animateElement(element, animation, duration = 300) {
    return new Promise(resolve => {
        element.style.animation = `${animation} ${duration}ms ease-out forwards`;
        setTimeout(() => {
            element.style.animation = '';
            resolve();
        }, duration);
    });
}

function fadeIn(element, duration = 300) {
    element.style.opacity = '0';
    element.style.display = '';
    element.offsetHeight; // Trigger reflow
    element.style.transition = `opacity ${duration}ms ease-out`;
    element.style.opacity = '1';

    return new Promise(resolve => setTimeout(resolve, duration));
}

function fadeOut(element, duration = 300) {
    element.style.transition = `opacity ${duration}ms ease-out`;
    element.style.opacity = '0';

    return new Promise(resolve => {
        setTimeout(() => {
            element.style.display = 'none';
            resolve();
        }, duration);
    });
}

function slideIn(element, direction = 'left', duration = 300) {
    const animations = {
        left: 'slideInLeft',
        right: 'slideInRight',
        up: 'slideInUp',
        down: 'slideInDown'
    };

    element.classList.add(`animate-slide-in-${direction}`);

    return new Promise(resolve => {
        setTimeout(() => {
            element.classList.remove(`animate-slide-in-${direction}`);
            resolve();
        }, duration);
    });
}

// ============= Ripple Effect =============

function createRipple(event, element) {
    const ripple = createElement('span', 'ripple');
    const rect = element.getBoundingClientRect();

    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;

    element.appendChild(ripple);

    setTimeout(() => ripple.remove(), 600);
}

// ============= Text Utilities =============

function escapeHtml(text) {
    const div = createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function truncate(text, maxLength = 50) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
}

function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
}

// ============= Storage Utilities =============

const storage = {
    get(key, defaultValue = null) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : defaultValue;
        } catch {
            return defaultValue;
        }
    },

    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },

    remove(key) {
        localStorage.removeItem(key);
    }
};

// ============= Toast Notifications =============

class Toast {
    static container = null;

    static init() {
        if (!this.container) {
            this.container = createElement('div', 'toast-container');
            document.body.appendChild(this.container);
        }
    }

    static show(message, type = 'info', duration = 4000) {
        this.init();

        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        const toast = createElement('div', `toast toast-${type}`);
        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${escapeHtml(message)}</span>
            <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
        `;

        this.container.appendChild(toast);

        // Auto remove
        setTimeout(() => {
            toast.style.animation = 'fadeOut 300ms ease-out forwards';
            setTimeout(() => toast.remove(), 300);
        }, duration);

        return toast;
    }

    static success(message, duration) {
        return this.show(message, 'success', duration);
    }

    static error(message, duration) {
        return this.show(message, 'error', duration);
    }

    static warning(message, duration) {
        return this.show(message, 'warning', duration);
    }

    static info(message, duration) {
        return this.show(message, 'info', duration);
    }
}

// ============= Debounce & Throttle =============

function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function throttle(func, limit = 100) {
    let inThrottle;
    return function (...args) {
        if (!inThrottle) {
            func.apply(this, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// ============= Markdown Parser (Enhanced) =============

function parseMarkdown(text) {
    if (!text) return '';

    // Extract thinking content before escaping HTML
    // Match <think>...</think> tags (case insensitive)
    // Extract thinking content before escaping HTML
    let thinkingHtml = '';

    // Improved regex to handle attributes and robust matching
    // Also handle case where </think> is missing (streaming)
    const thinkStartRegex = /<think(?:\s[^>]*)?>/i;
    const thinkEndRegex = /<\/think>/i;

    if (thinkStartRegex.test(text)) {
        let content = '';
        let mainText = '';

        const startMatch = text.match(thinkStartRegex);
        const startIndex = startMatch.index;
        const afterStart = text.slice(startIndex + startMatch[0].length);

        const endMatch = afterStart.match(thinkEndRegex);

        if (endMatch) {
            // Complete block
            content = afterStart.slice(0, endMatch.index);
            mainText = text.slice(0, startIndex) + afterStart.slice(endMatch.index + endMatch[0].length);
        } else {
            // Incomplete block (streaming) - treat everything after start as thinking
            content = afterStart;
            mainText = text.slice(0, startIndex);
        }

        if (content) {
            const escapedThinking = escapeHtml(content);
            thinkingHtml = `
                <details class="thinking-toggle">
                    <summary class="thinking-summary">
                        <span class="thinking-icon">💭</span>
                        <span class="thinking-label">Thinking Process</span>
                        <span class="thinking-arrow">▶</span>
                    </summary>
                    <div class="thinking-content">${escapedThinking.replace(/\n/g, '<br>')}</div>
                </details>
            `;

            // Only update text if we found a think block
            text = mainText;
        }
    }

    // Escape HTML first
    let html = escapeHtml(text);

    // Code blocks (must be first to prevent other formatting inside)
    html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        const langClass = lang ? ` class="language-${lang}"` : '';
        const langLabel = lang ? `<span class="code-lang">${lang}</span>` : '';
        return `<div class="code-block">${langLabel}<pre><code${langClass}>${code.trim()}</code></pre></div>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

    // Headings (## and ###)
    html = html.replace(/^### (.+)$/gm, '<h4 class="md-heading md-h4">$1</h4>');
    html = html.replace(/^## (.+)$/gm, '<h3 class="md-heading md-h3">$1</h3>');
    html = html.replace(/^# (.+)$/gm, '<h2 class="md-heading md-h2">$1</h2>');

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr class="md-hr">');

    // Blockquotes (including notes/warnings)
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Audio links [Audio](url)
    html = html.replace(/\[Audio\]\(([^)]+)\)/g, '<div class="generated-audio-wrapper" style="margin-top: 8px;"><audio controls src="$1" class="generated-audio" style="width: 100%;"></audio></div>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li class="md-li">$1</li>');
    html = html.replace(/(<li class="md-li">.*<\/li>\n?)+/g, '<ul class="md-ul">$&</ul>');

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, '<li class="md-oli">$1</li>');
    html = html.replace(/(<li class="md-oli">.*<\/li>\n?)+/g, '<ol class="md-ol">$&</ol>');

    // Line breaks (but not inside pre/code blocks)
    html = html.replace(/\n/g, '<br>');

    // Clean up multiple br tags
    html = html.replace(/(<br>){3,}/g, '<br><br>');

    // Remove br after block elements
    html = html.replace(/(<\/h[2-4]>)<br>/g, '$1');
    html = html.replace(/(<\/blockquote>)<br>/g, '$1');
    html = html.replace(/(<\/ul>)<br>/g, '$1');
    html = html.replace(/(<\/ol>)<br>/g, '$1');
    html = html.replace(/(<hr class="md-hr">)<br>/g, '$1');
    html = html.replace(/(<\/div>)<br>/g, '$1');

    // Merge consecutive blockquotes
    html = html.replace(/<\/blockquote><br><blockquote class="md-blockquote">/g, '<br>');

    // Prepend thinking section if present
    if (thinkingHtml) {
        html = thinkingHtml + html;
    }

    return html;
}

// ============= Keyboard Shortcuts =============

class KeyboardShortcuts {
    constructor() {
        this.shortcuts = new Map();
        this.init();
    }

    init() {
        document.addEventListener('keydown', (e) => this.handleKeydown(e));
    }

    handleKeydown(e) {
        const key = this.getKeyString(e);
        const handler = this.shortcuts.get(key);

        if (handler && !this.isInputFocused()) {
            e.preventDefault();
            handler(e);
        }
    }

    getKeyString(e) {
        const parts = [];
        if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        parts.push(e.key.toUpperCase());
        return parts.join('+');
    }

    isInputFocused() {
        const active = document.activeElement;
        return active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable
        );
    }

    register(shortcut, handler) {
        this.shortcuts.set(shortcut, handler);
    }

    unregister(shortcut) {
        this.shortcuts.delete(shortcut);
    }
}

// ============= Voice Utilities =============

class VoiceInput {
    constructor() {
        this.recognition = null;
        this.isListening = false;
        this.onResult = null;
        this.onEnd = null;

        this.init();
    }

    init() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (SpeechRecognition) {
            this.recognition = new SpeechRecognition();
            this.recognition.continuous = false;
            this.recognition.interimResults = true;
            this.recognition.lang = 'en-US';

            this.recognition.onresult = (event) => {
                const transcript = Array.from(event.results)
                    .map(result => result[0].transcript)
                    .join('');

                if (this.onResult) {
                    this.onResult(transcript, event.results[0].isFinal);
                }
            };

            this.recognition.onend = () => {
                this.isListening = false;
                if (this.onEnd) this.onEnd();
            };
        }
    }

    isSupported() {
        return !!this.recognition;
    }

    start() {
        if (!this.recognition) return false;

        try {
            this.recognition.start();
            this.isListening = true;
            return true;
        } catch (error) {
            console.error('Voice input error:', error);
            return false;
        }
    }

    stop() {
        if (this.recognition && this.isListening) {
            this.recognition.stop();
            this.isListening = false;
        }
    }
}

class VoiceOutput {
    constructor() {
        this.synth = window.speechSynthesis;
        this.isSpeaking = false;
    }

    isSupported() {
        return !!this.synth;
    }

    speak(text) {
        if (!this.synth) return false;

        // Cancel any ongoing speech
        this.synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1;
        utterance.pitch = 1;

        utterance.onstart = () => this.isSpeaking = true;
        utterance.onend = () => this.isSpeaking = false;

        this.synth.speak(utterance);
        return true;
    }

    stop() {
        if (this.synth) {
            this.synth.cancel();
            this.isSpeaking = false;
        }
    }
}

// ============= File Utilities =============

function isImageFile(file) {
    return file.type.startsWith('image/');
}

function isVideoFile(file) {
    return file.type.startsWith('video/');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function createFilePreview(file) {
    return new Promise((resolve, reject) => {
        if (isImageFile(file)) {
            const reader = new FileReader();
            reader.onload = (e) => resolve({ type: 'image', url: e.target.result });
            reader.onerror = reject;
            reader.readAsDataURL(file);
        } else if (isVideoFile(file)) {
            const url = URL.createObjectURL(file);
            resolve({ type: 'video', url });
        } else {
            reject(new Error('Unsupported file type'));
        }
    });
}

// ============= Export =============

window.utils = {
    $, $$, createElement,
    animateElement, fadeIn, fadeOut, slideIn, createRipple,
    escapeHtml, truncate, formatDate, parseMarkdown,
    storage, debounce, throttle,
    isImageFile, isVideoFile, formatFileSize, createFilePreview
};

window.Toast = Toast;
window.KeyboardShortcuts = KeyboardShortcuts;
window.VoiceInput = VoiceInput;
window.VoiceOutput = VoiceOutput;
