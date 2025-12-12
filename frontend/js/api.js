/**
 * TangLLM API Client
 * Handles all API communication with the backend
 */

class APIClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl; // Default to empty string for relative paths
        this.token = localStorage.getItem('tangllm_token');
        this.refreshToken = localStorage.getItem('tangllm_refresh_token');
    }

    // ============= Helper Methods =============

    getHeaders(includeAuth = true) {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (includeAuth && this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        console.log('getHeaders called, includeAuth:', includeAuth, 'token exists:', !!this.token, 'headers:', headers);
        return headers;
    }

    setTokens(accessToken, refreshToken) {
        this.token = accessToken;
        this.refreshToken = refreshToken;
        localStorage.setItem('tangllm_token', accessToken);
        localStorage.setItem('tangllm_refresh_token', refreshToken);
    }

    clearTokens() {
        this.token = null;
        this.refreshToken = null;
        localStorage.removeItem('tangllm_token');
        localStorage.removeItem('tangllm_refresh_token');
    }

    isAuthenticated() {
        return !!this.token;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const config = {
            ...options,
            headers: {
                ...this.getHeaders(options.auth !== false),
                ...options.headers
            }
        };

        try {
            const response = await fetch(url, config);

            // Handle 401 - try to refresh token (but not for auth endpoints to avoid loops)
            if (response.status === 401 && this.refreshToken && !endpoint.includes('/auth/')) {
                const refreshed = await this.refreshTokens();
                if (refreshed) {
                    config.headers['Authorization'] = `Bearer ${this.token}`;
                    return fetch(url, config).then(r => this.handleResponse(r));
                }
            }

            return this.handleResponse(response);
        } catch (error) {
            console.error('API request failed:', error);
            throw error;
        }
    }

    async handleResponse(response) {
        const data = await response.json().catch(() => null);

        if (!response.ok) {
            let errorMessage = 'Request failed';

            if (data?.detail) {
                // Handle Pydantic validation errors (array of objects)
                if (Array.isArray(data.detail)) {
                    errorMessage = data.detail.map(err => {
                        const field = err.loc?.[err.loc.length - 1] || 'field';
                        return `${field}: ${err.msg}`;
                    }).join(', ');
                } else if (typeof data.detail === 'string') {
                    errorMessage = data.detail;
                } else {
                    errorMessage = JSON.stringify(data.detail);
                }
            }

            const error = new Error(errorMessage);
            error.status = response.status;
            error.data = data;
            throw error;
        }

        return data;
    }

    // ============= Auth Endpoints =============

    async register(username, email, password, fullName = null) {
        return this.request('api/auth/register', {
            method: 'POST',
            body: JSON.stringify({ username, email, password, full_name: fullName }),
            auth: false
        });
    }

    async login(username, password) {
        const data = await this.request('api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
            auth: false
        });

        this.setTokens(data.access_token, data.refresh_token);
        return data;
    }

    async refreshTokens() {
        if (!this.refreshToken) {
            return false;
        }

        try {
            const data = await this.request('api/auth/refresh', {
                method: 'POST',
                body: JSON.stringify({ refresh_token: this.refreshToken }),
                auth: false
            });

            this.setTokens(data.access_token, data.refresh_token);
            return true;
        } catch (error) {
            this.clearTokens();
            return false;
        }
    }

    async getCurrentUser() {
        return this.request('api/auth/me');
    }

    async getAvailableModels() {
        return this.request('api/chat/models');
    }

    async changePassword(currentPassword, newPassword) {
        return this.request('api/auth/password', {
            method: 'PUT',
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword
            })
        });
    }

    logout() {
        this.clearTokens();
    }

    // ============= Chat Endpoints =============

    async sendMessage(content, conversationId = null, stream = true) {
        // For streaming, we use fetch directly with SSE
        if (stream) {
            return this.sendMessageStream(content, conversationId);
        }

        return this.request('api/chat', {
            method: 'POST',
            body: JSON.stringify({
                conversation_id: conversationId,
                content: content,
                stream: false
            })
        });
    }

    async sendMessageStream(content, conversationId = null, signal = null) {
        const fetchOptions = {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify({
                conversation_id: conversationId,
                content: content,
                stream: true
            })
        };

        if (signal) {
            fetchOptions.signal = signal;
        }

        const response = await fetch(`${this.baseUrl}api/chat`, fetchOptions);

        if (!response.ok) {
            const data = await response.json().catch(() => null);
            throw new Error(data?.detail || 'Request failed');
        }

        return response.body;
    }

    // ============= Conversations Endpoints =============

    async getConversations(skip = 0, limit = 50) {
        return this.request(`api/conversations?skip=${skip}&limit=${limit}`);
    }

    async createConversation(title = null, systemPrompt = null) {
        return this.request('api/conversations', {
            method: 'POST',
            body: JSON.stringify({
                title: title,
                system_prompt: systemPrompt
            })
        });
    }

    async getConversation(conversationId) {
        return this.request(`api/conversations/${conversationId}`);
    }

    async updateConversation(conversationId, updates) {
        return this.request(`api/conversations/${conversationId}`, {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
    }

    async deleteConversation(conversationId) {
        return this.request(`api/conversations/${conversationId}`, {
            method: 'DELETE'
        });
    }

    async deleteAllConversations() {
        return this.request('api/conversations/', {
            method: 'DELETE'
        });
    }

    async branchConversation(conversationId, messageId, newTitle = null) {
        return this.request(`api/conversations/${conversationId}/branch`, {
            method: 'POST',
            body: JSON.stringify({
                message_id: messageId,
                new_title: newTitle
            })
        });
    }

    async exportConversation(conversationId, format = 'markdown') {
        return this.request(`api/conversations/${conversationId}/export?format=${format}`);
    }

    async getSharedConversation(shareToken) {
        return this.request(`api/conversations/shared/${shareToken}`, { auth: false });
    }

    // ============= Files Endpoints =============

    async uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);

        const doUpload = async () => {
            return await fetch(`${this.baseUrl}api/files/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`
                },
                body: formData
            });
        };

        let response = await doUpload();

        // Handle 401 - try to refresh token
        if (response.status === 401 && this.refreshToken) {
            const refreshed = await this.refreshTokens();
            if (refreshed) {
                response = await doUpload();
            }
        }

        return this.handleResponse(response);
    }

    async deleteFile(relativePath) {
        return this.request(`api/files/${relativePath}`, {
            method: 'DELETE'
        });
    }

    // ============= Settings Endpoints =============

    async getSettings() {
        return this.request('api/settings');
    }

    async updateSettings(updates) {
        return this.request('api/settings', {
            method: 'PUT',
            body: JSON.stringify(updates)
        });
    }

    async resetSettings() {
        return this.request('api/settings/reset', {
            method: 'POST'
        });
    }
}

// Create global API instance
window.api = new APIClient();
