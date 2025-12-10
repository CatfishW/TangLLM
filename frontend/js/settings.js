/**
 * TangLLM Settings Manager
 * User settings and preferences
 */

class SettingsManager {
    constructor() {
        this.settings = null;
    }

    async init() {
        try {
            this.settings = await api.getSettings();
        } catch (error) {
            console.error('Failed to load settings:', error);
        }
    }

    async updateSettings(updates) {
        try {
            this.settings = await api.updateSettings(updates);
            Toast.success('Settings saved');
            return true;
        } catch (error) {
            Toast.error('Failed to save settings');
            return false;
        }
    }

    async resetSettings() {
        try {
            const result = await api.resetSettings();
            this.settings = result.settings;
            Toast.success('Settings reset to defaults');
            this.openSettings(); // Refresh the modal
            return true;
        } catch (error) {
            Toast.error('Failed to reset settings');
            return false;
        }
    }

    openSettings() {
        const overlay = document.getElementById('modal-overlay');
        const modal = document.getElementById('modal');

        if (!overlay || !modal) return;

        modal.innerHTML = `
            <div class="modal-header">
                <h3 class="modal-title">Settings</h3>
                <button class="modal-close" onclick="settingsManager.closeSettings()">✕</button>
            </div>
            
            <div class="modal-body" style="max-height: 60vh; overflow-y: auto;">
                <div class="tabs" style="margin-bottom: var(--space-6);">
                    <button class="tab active" onclick="settingsManager.switchTab('model')">Model</button>
                    <button class="tab" onclick="settingsManager.switchTab('preferences')">Preferences</button>
                    <button class="tab" onclick="settingsManager.switchTab('account')">Account</button>
                </div>
                
                <div id="settings-content">
                    ${this.renderModelTab()}
                </div>
            </div>
            
            <div class="modal-footer">
                <button class="btn btn-secondary" onclick="settingsManager.resetSettings()">Reset Defaults</button>
                <button class="btn btn-primary" onclick="settingsManager.saveAndClose()">Save & Close</button>
            </div>
        `;

        overlay.classList.add('active');
    }

    closeSettings() {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    async saveAndClose() {
        const updates = {};

        // Gather form values
        const apiBase = document.getElementById('api-base')?.value;
        const modelId = document.getElementById('model-id')?.value;
        const apiKey = document.getElementById('api-key')?.value;
        const systemPrompt = document.getElementById('system-prompt')?.value;
        const temperature = document.getElementById('temperature')?.value;
        const maxTokens = document.getElementById('max-tokens')?.value;
        const theme = document.getElementById('theme')?.value;
        const enableVoice = document.getElementById('enable-voice')?.checked;
        const enableSounds = document.getElementById('enable-sounds')?.checked;

        if (apiBase !== undefined) updates.api_base_url = apiBase;
        if (modelId !== undefined) updates.model_id = modelId;
        if (apiKey !== undefined) updates.api_key = apiKey;
        if (systemPrompt !== undefined) updates.system_prompt = systemPrompt;
        if (temperature !== undefined) updates.temperature = temperature;
        if (maxTokens !== undefined) updates.max_tokens = parseInt(maxTokens);
        if (theme !== undefined) updates.theme = theme;
        if (enableVoice !== undefined) updates.enable_voice = enableVoice;
        if (enableSounds !== undefined) updates.enable_sounds = enableSounds;

        await this.updateSettings(updates);
        this.closeSettings();

        // Apply theme
        if (updates.theme) {
            document.body.setAttribute('data-theme', updates.theme);
        }
    }

    switchTab(tab) {
        // Update tab buttons
        const tabs = document.querySelectorAll('.tab');
        tabs.forEach(t => t.classList.remove('active'));
        event.target.classList.add('active');

        // Render tab content
        const content = document.getElementById('settings-content');
        if (!content) return;

        switch (tab) {
            case 'model':
                content.innerHTML = this.renderModelTab();
                break;
            case 'preferences':
                content.innerHTML = this.renderPreferencesTab();
                break;
            case 'account':
                content.innerHTML = this.renderAccountTab();
                break;
        }
    }

    renderModelTab() {
        return `
            <div class="settings-section">
                <h4 class="settings-section-title">API Configuration</h4>
                
                <div class="input-group">
                    <label class="input-label" for="api-base">API Base URL</label>
                    <input type="text" id="api-base" class="input" 
                           value="${this.settings?.api_base_url || ''}"
                           placeholder="https://game.agaii.org/mllm/v1">
                </div>
                
                <div class="input-group" style="margin-top: var(--space-4);">
                    <label class="input-label" for="model-id">Model ID</label>
                    <input type="text" id="model-id" class="input" 
                           value="${this.settings?.model_id || ''}"
                           placeholder="Qwen/Qwen3-VL-30B-A3B-Instruct-FP8">
                </div>
                
                <div class="input-group" style="margin-top: var(--space-4);">
                    <label class="input-label" for="api-key">API Key (optional)</label>
                    <input type="password" id="api-key" class="input" 
                           value="${this.settings?.api_key || ''}"
                           placeholder="Enter API key if required">
                </div>
            </div>
            
            <div class="settings-section">
                <h4 class="settings-section-title">Generation Settings</h4>
                
                <div class="input-group">
                    <label class="input-label" for="system-prompt">System Prompt</label>
                    <textarea id="system-prompt" class="input textarea" rows="3"
                              placeholder="You are a helpful assistant...">${this.settings?.system_prompt || ''}</textarea>
                </div>
                
                <div class="input-group" style="margin-top: var(--space-4);">
                    <label class="input-label" for="temperature">Temperature: <span id="temp-value">${this.settings?.temperature || '0.7'}</span></label>
                    <input type="range" id="temperature" 
                           min="0" max="2" step="0.1" 
                           value="${this.settings?.temperature || '0.7'}"
                           style="width: 100%;"
                           oninput="document.getElementById('temp-value').textContent = this.value">
                </div>
                
                <div class="input-group" style="margin-top: var(--space-4);">
                    <label class="input-label" for="max-tokens">Max Tokens</label>
                    <input type="number" id="max-tokens" class="input" 
                           value="${this.settings?.max_tokens || 4096}"
                           min="1" max="32000">
                </div>
            </div>
        `;
    }

    renderPreferencesTab() {
        return `
            <div class="settings-section">
                <h4 class="settings-section-title">Appearance</h4>
                
                <div class="settings-row">
                    <div>
                        <div class="settings-label">Theme</div>
                        <div class="settings-description">Choose your preferred color scheme</div>
                    </div>
                    <select id="theme" class="input" style="width: auto;">
                        <option value="dark" ${this.settings?.theme === 'dark' ? 'selected' : ''}>Dark</option>
                        <option value="light" ${this.settings?.theme === 'light' ? 'selected' : ''}>Light</option>
                    </select>
                </div>
            </div>
            
            <div class="settings-section">
                <h4 class="settings-section-title">Accessibility</h4>
                
                <div class="settings-row">
                    <div>
                        <div class="settings-label">Voice Features</div>
                        <div class="settings-description">Enable speech recognition and text-to-speech</div>
                    </div>
                    <label class="toggle">
                        <input type="checkbox" id="enable-voice" ${this.settings?.enable_voice ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                
                <div class="settings-row">
                    <div>
                        <div class="settings-label">Sound Effects</div>
                        <div class="settings-description">Play sounds for notifications and actions</div>
                    </div>
                    <label class="toggle">
                        <input type="checkbox" id="enable-sounds" ${this.settings?.enable_sounds ? 'checked' : ''}>
                        <span class="toggle-slider"></span>
                    </label>
                </div>
            </div>
            
            <div class="settings-section">
                <h4 class="settings-section-title">Keyboard Shortcuts</h4>
                
                <div style="font-size: var(--text-sm); color: var(--color-text-secondary);">
                    <p><kbd>Ctrl</kbd> + <kbd>Enter</kbd> - Send message</p>
                    <p><kbd>Ctrl</kbd> + <kbd>N</kbd> - New chat</p>
                    <p><kbd>Ctrl</kbd> + <kbd>,</kbd> - Open settings</p>
                    <p><kbd>Ctrl</kbd> + <kbd>/</kbd> - Show shortcuts</p>
                </div>
            </div>
        `;
    }

    renderAccountTab() {
        const user = authManager.getUser();

        return `
            <div class="settings-section">
                <h4 class="settings-section-title">Profile</h4>
                
                <div style="display: flex; align-items: center; gap: var(--space-4); margin-bottom: var(--space-4);">
                    <div class="avatar avatar-lg">${user?.username?.[0] || 'U'}</div>
                    <div>
                        <div style="font-weight: var(--font-semibold);">${user?.full_name || user?.username}</div>
                        <div style="font-size: var(--text-sm); color: var(--color-text-secondary);">${user?.email}</div>
                    </div>
                </div>
                
                <p style="font-size: var(--text-sm); color: var(--color-text-tertiary);">
                    Member since ${user?.created_at ? new Date(user.created_at).toLocaleDateString() : 'Unknown'}
                </p>
            </div>
            
            <div class="settings-section">
                <h4 class="settings-section-title">Change Password</h4>
                
                <div class="input-group">
                    <label class="input-label" for="current-password">Current Password</label>
                    <input type="password" id="current-password" class="input" placeholder="Enter current password">
                </div>
                
                <div class="input-group" style="margin-top: var(--space-4);">
                    <label class="input-label" for="new-password">New Password</label>
                    <input type="password" id="new-password" class="input" placeholder="Enter new password">
                </div>
                
                <button class="btn btn-secondary" style="margin-top: var(--space-4);" onclick="settingsManager.changePassword()">
                    Update Password
                </button>
            </div>
            
            <div class="settings-section">
                <h4 class="settings-section-title">Danger Zone</h4>
                
                <button class="btn btn-secondary" style="border-color: var(--color-error); color: var(--color-error);" 
                        onclick="authManager.logout(); renderAuthPage();">
                    Sign Out
                </button>
            </div>
        `;
    }

    async changePassword() {
        const currentPassword = document.getElementById('current-password')?.value;
        const newPassword = document.getElementById('new-password')?.value;

        if (!currentPassword || !newPassword) {
            Toast.error('Please fill in both password fields');
            return;
        }

        if (newPassword.length < 6) {
            Toast.error('New password must be at least 6 characters');
            return;
        }

        const success = await authManager.changePassword(currentPassword, newPassword);
        if (success) {
            document.getElementById('current-password').value = '';
            document.getElementById('new-password').value = '';
        }
    }
}

// Create global settings manager
window.settingsManager = new SettingsManager();
