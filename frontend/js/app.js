/**
 * TangLLM Main Application
 * Application entry point and initialization
 */

// ============= Main App Render =============

async function renderApp() {
    const app = document.getElementById('app');

    // Show loading
    app.innerHTML = `
        <div style="height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: var(--space-4);">
            <div class="spinner spinner-lg"></div>
            <p style="color: var(--color-text-secondary);">Loading TangLLM...</p>
        </div>
    `;

    // Initialize managers
    await chatManager.init();
    await settingsManager.init();

    // Auto-fetch available models and ensure valid model is selected
    try {
        const result = await api.getAvailableModels();
        if (result.models && result.models.length > 0) {
            settingsManager.availableModels = result.models;

            // If current model is not in list, auto-select first available
            const currentModel = settingsManager.settings?.model_id;
            const modelIds = result.models.map(m => m.id);

            if (!currentModel || !modelIds.includes(currentModel)) {
                const firstModel = result.models[0].id;
                console.log(`Auto-selecting model: ${firstModel}`);
                await api.updateSettings({ model_id: firstModel });
                if (settingsManager.settings) {
                    settingsManager.settings.model_id = firstModel;
                }
            }
        }
    } catch (err) {
        console.warn('Failed to auto-fetch models:', err);
    }

    // Render main layout
    app.innerHTML = `
        <canvas id="particle-canvas"></canvas>
        
        <!-- Sidebar -->
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <div class="sidebar-logo">
                    <div class="logo-badge">
                        <img src="assets/rowan-logo.png" alt="Rowan University" class="sidebar-logo-image" style="height: 24px; width: auto;">
                    </div>
                </div>
            </div>
            
            <div class="sidebar-content" id="sidebar-content">
                <!-- Conversations loaded here -->
            </div>
            
            <div class="sidebar-footer">
                <div class="user-profile dropdown" id="user-dropdown">
                    <div class="user-profile-btn">
                        <div class="avatar avatar-sm">${authManager.getUser()?.username?.[0] || 'U'}</div>
                        <div class="user-info">
                            <div class="user-name">${authManager.getUser()?.full_name || authManager.getUser()?.username}</div>
                            <div class="user-subtext">Free Plan</div>
                        </div>
                        <span class="user-menu-icon">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <circle cx="12" cy="12" r="1"></circle>
                                <circle cx="19" cy="12" r="1"></circle>
                                <circle cx="5" cy="12" r="1"></circle>
                            </svg>
                        </span>
                    </div>
                    
                    <div class="dropdown-menu user-dropdown-menu">
                        <div class="dropdown-header">
                            <div class="user-name">${authManager.getUser()?.full_name || authManager.getUser()?.username}</div>
                            <div class="user-email">${authManager.getUser()?.email}</div>
                        </div>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item" onclick="settingsManager.openSettings()">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                            Settings
                        </button>
                        <button class="dropdown-item item-danger" onclick="chatManager.clearAllHistory()">
                             <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                            Clear All History
                        </button>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item" onclick="authManager.logout(); renderAuthPage();">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;">
                                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                <polyline points="16 17 21 12 16 7"></polyline>
                                <line x1="21" y1="12" x2="9" y2="12"></line>
                            </svg>
                            Sign Out
                        </button>
                    </div>
                </div>
            </div>
        </aside>
        
        <!-- Toggle Sidebar Button -->
        <button class="toggle-sidebar-btn" id="toggle-sidebar" onclick="toggleSidebar()">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        
        <!-- Main Content -->
        <main class="app-content">
            <div class="chat-container" id="chat-container">
                <!-- Chat content loaded here -->
            </div>
        </main>
        
        <!-- Modal -->
        <div class="modal-overlay" id="modal-overlay" onclick="if(event.target === this) settingsManager.closeSettings()">
            <div class="modal" id="modal">
                <!-- Modal content loaded here -->
            </div>
        </div>
    `;

    // Initialize particles
    if (window.ParticleSystem) {
        new ParticleSystem('particle-canvas');
    }

    // Render components
    chatManager.renderSidebar();
    chatManager.renderChat();

    // Setup dropdown
    setupDropdown();

    // Setup keyboard shortcuts
    setupKeyboardShortcuts();

    // Setup drag and drop for files
    setupDragDrop();

    // Setup clipboard paste for images
    setupClipboardPaste();
}

// ============= UI Helpers =============

function toggleSidebar() {
    const app = document.getElementById('app');

    if (window.innerWidth <= 768) {
        app.classList.toggle('sidebar-open');
    } else {
        app.classList.toggle('sidebar-collapsed');
    }
}

function setupDropdown() {
    const dropdown = document.getElementById('user-dropdown');
    if (!dropdown) return;

    dropdown.addEventListener('click', (e) => {
        if (e.target.closest('.dropdown-item')) return;
        dropdown.classList.toggle('active');
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target)) {
            dropdown.classList.remove('active');
        }
    });
}

function setupKeyboardShortcuts() {
    const shortcuts = new KeyboardShortcuts();

    shortcuts.register('Ctrl+N', () => {
        chatManager.createNewChat();
    });

    shortcuts.register('Ctrl+,', () => {
        settingsManager.openSettings();
    });

    shortcuts.register('Ctrl+/', () => {
        Toast.info('Ctrl+Enter: Send | Ctrl+N: New chat | Ctrl+,: Settings');
    });

    shortcuts.register('ESCAPE', () => {
        settingsManager.closeSettings();
    });
}

function setupDragDrop() {
    const app = document.getElementById('app');

    app.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    app.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const files = Array.from(e.dataTransfer.files).filter(
            f => utils.isImageFile(f) || utils.isVideoFile(f)
        );

        if (files.length > 0) {
            await chatManager.handleFileUpload(files);
        }
    });
}

function setupClipboardPaste() {
    // Listen for paste events on the document
    document.addEventListener('paste', async (e) => {
        // Check if we have clipboard data with items
        const clipboardData = e.clipboardData || window.clipboardData;
        if (!clipboardData || !clipboardData.items) return;

        const items = Array.from(clipboardData.items);
        // Support both images and videos
        const mediaItems = items.filter(item =>
            item.type.startsWith('image/') || item.type.startsWith('video/')
        );

        if (mediaItems.length === 0) return;

        // Prevent default paste behavior for media
        e.preventDefault();

        // Convert clipboard items to files
        const files = [];
        for (const item of mediaItems) {
            const file = item.getAsFile();
            if (file) {
                // Determine if it's image or video
                const isVideo = item.type.startsWith('video/');
                const prefix = isVideo ? 'pasted_video' : 'pasted_image';
                const extension = file.type.split('/')[1] || (isVideo ? 'mp4' : 'png');

                const newFile = new File([file], `${prefix}_${Date.now()}.${extension}`, {
                    type: file.type
                });
                files.push(newFile);
            }
        }

        if (files.length > 0) {
            await chatManager.handleFileUpload(files);
            Toast.success(`Pasted ${files.length} file(s) from clipboard`);
        }
    });
}

// ============= App Initialization =============

document.addEventListener('DOMContentLoaded', async () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║                       TangLLM                            ║
    ║          ChatGPT-like Web Application                    ║
    ║                                                          ║
    ║   Advisor: Ying Tang                                     ║
    ║   Developer: Yanlai Wu                                   ║
    ║                                                          ║
    ║   Rowan University - Dept. of Electrical & Computer Eng.  ║
    ╚══════════════════════════════════════════════════════════╝
    `);

    // Check authentication
    const isAuthenticated = await authManager.init();

    if (isAuthenticated) {
        await renderApp();
    } else {
        renderAuthPage();
    }
});
