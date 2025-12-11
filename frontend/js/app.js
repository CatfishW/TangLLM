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

    // Render main layout
    app.innerHTML = `
        <canvas id="particle-canvas"></canvas>
        
        <!-- Sidebar -->
        <aside class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <div class="sidebar-logo">
                    <div class="sidebar-logo-icon">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2"/>
                            <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2"/>
                        </svg>
                    </div>
                    <span class="sidebar-logo-text text-gradient">TangLLM</span>
                </div>
            </div>
            
            <div class="sidebar-content" id="sidebar-content">
                <!-- Conversations loaded here -->
            </div>
            
            <div class="sidebar-footer">
                <div class="user-profile dropdown" id="user-dropdown">
                    <div class="avatar">${authManager.getUser()?.username?.[0] || 'U'}</div>
                    <div class="user-info">
                        <div class="user-name">${authManager.getUser()?.full_name || authManager.getUser()?.username}</div>
                        <div class="user-email">${authManager.getUser()?.email}</div>
                    </div>
                    <span>⋮</span>
                    
                    <div class="dropdown-menu">
                        <button class="dropdown-item" onclick="settingsManager.openSettings()">
                            ⚙️ Settings
                        </button>
                        <div class="dropdown-divider"></div>
                        <button class="dropdown-item" onclick="authManager.logout(); renderAuthPage();">
                            🚪 Sign Out
                        </button>
                    </div>
                </div>
            </div>
        </aside>
        
        <!-- Toggle Sidebar Button -->
        <button class="toggle-sidebar-btn" id="toggle-sidebar" onclick="toggleSidebar()">
            ☰
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
    app.classList.toggle('sidebar-collapsed');
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
        const imageItems = items.filter(item => item.type.startsWith('image/'));

        if (imageItems.length === 0) return;

        // Prevent default paste behavior for images
        e.preventDefault();

        // Convert clipboard items to files
        const files = [];
        for (const item of imageItems) {
            const file = item.getAsFile();
            if (file) {
                // Create a new file with a proper name
                const extension = file.type.split('/')[1] || 'png';
                const newFile = new File([file], `pasted_image_${Date.now()}.${extension}`, {
                    type: file.type
                });
                files.push(newFile);
            }
        }

        if (files.length > 0) {
            await chatManager.handleFileUpload(files);
            Toast.success(`Pasted ${files.length} image(s) from clipboard`);
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
