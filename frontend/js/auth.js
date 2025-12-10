/**
 * TangLLM Authentication Module
 * Handles login, registration, and auth state
 */

class AuthManager {
    constructor() {
        this.user = null;
        this.onAuthChange = null;
    }

    async init() {
        // Check if we have a valid session
        if (api.isAuthenticated()) {
            try {
                this.user = await api.getCurrentUser();
                if (this.onAuthChange) this.onAuthChange(this.user);
                return true;
            } catch (error) {
                api.clearTokens();
                return false;
            }
        }
        return false;
    }

    isAuthenticated() {
        return !!this.user;
    }

    getUser() {
        return this.user;
    }

    async login(username, password) {
        try {
            await api.login(username, password);
            this.user = await api.getCurrentUser();
            if (this.onAuthChange) this.onAuthChange(this.user);
            Toast.success('Welcome back!');
            return true;
        } catch (error) {
            Toast.error(error.message || 'Login failed');
            return false;
        }
    }

    async register(username, email, password, fullName = null) {
        try {
            console.log('1. Calling api.register...');
            await api.register(username, email, password, fullName);
            console.log('2. Registration successful, calling api.login...');

            // Auto login after registration
            const loginResult = await api.login(username, password);
            console.log('3. Login successful, token:', api.token ? 'SET' : 'NOT SET');

            console.log('4. Calling api.getCurrentUser...');
            this.user = await api.getCurrentUser();
            console.log('5. Got user:', this.user);

            if (this.onAuthChange) this.onAuthChange(this.user);
            Toast.success('Account created! Welcome to TangLLM!');
            return true;
        } catch (error) {
            console.error('Registration error:', error);
            Toast.error(error.message || 'Registration failed');
            return false;
        }
    }

    logout() {
        api.logout();
        this.user = null;
        if (this.onAuthChange) this.onAuthChange(null);
        Toast.info('You have been logged out');
    }

    async changePassword(currentPassword, newPassword) {
        try {
            await api.changePassword(currentPassword, newPassword);
            Toast.success('Password changed successfully');
            return true;
        } catch (error) {
            Toast.error(error.message || 'Failed to change password');
            return false;
        }
    }
}

// ============= Auth UI =============

function renderAuthPage(type = 'login') {
    const app = document.getElementById('app');

    const isLogin = type === 'login';

    app.innerHTML = `
        <canvas id="particle-canvas"></canvas>
        <div class="auth-page">
            <div class="auth-container">
                <div class="auth-card">
                    <div class="auth-header">
                        <div class="auth-logo">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </div>
                        <h1 class="auth-title">${isLogin ? 'Welcome Back' : 'Create Account'}</h1>
                        <p class="auth-subtitle">${isLogin ? 'Sign in to continue to TangLLM' : 'Join TangLLM today'}</p>
                    </div>
                    
                    <form class="auth-form" id="auth-form">
                        ${!isLogin ? `
                        <div class="input-group">
                            <label class="input-label" for="fullName">Full Name</label>
                            <input type="text" id="fullName" class="input" placeholder="Enter your name">
                        </div>
                        ` : ''}
                        
                        <div class="input-group">
                            <label class="input-label" for="username">Username</label>
                            <input type="text" id="username" class="input" placeholder="Enter your username" required>
                        </div>
                        
                        ${!isLogin ? `
                        <div class="input-group">
                            <label class="input-label" for="email">Email</label>
                            <input type="email" id="email" class="input" placeholder="Enter your email" required>
                        </div>
                        ` : ''}
                        
                        <div class="input-group">
                            <label class="input-label" for="password">Password</label>
                            <input type="password" id="password" class="input" placeholder="Enter your password" required>
                        </div>
                        
                        ${!isLogin ? `
                        <div class="input-group">
                            <label class="input-label" for="confirmPassword">Confirm Password</label>
                            <input type="password" id="confirmPassword" class="input" placeholder="Confirm your password" required>
                        </div>
                        ` : ''}
                        
                        <button type="submit" class="btn btn-primary btn-lg" style="width: 100%; margin-top: var(--space-2);">
                            ${isLogin ? 'Sign In' : 'Create Account'}
                        </button>
                    </form>
                    
                    <div class="auth-footer">
                        ${isLogin ?
            `Don't have an account? <a href="#" id="switch-auth">Sign up</a>` :
            `Already have an account? <a href="#" id="switch-auth">Sign in</a>`
        }
                    </div>
                </div>
                
                <p style="text-align: center; margin-top: var(--space-4); font-size: var(--text-xs); color: var(--color-text-tertiary);">
                    Advisor: Ying Tang | Developer: Yanlai Wu<br>
                    Rowan University - Department of Electrical and Computer Engineering
                </p>
            </div>
        </div>
    `;

    // Reinitialize particles
    if (window.ParticleSystem) {
        new ParticleSystem('particle-canvas');
    }

    // Form submission
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const submitBtn = e.target.querySelector('[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span class="spinner spinner-sm"></span> Please wait...';

        if (isLogin) {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;

            const success = await authManager.login(username, password);
            if (success) {
                renderApp();
            }
        } else {
            const fullName = document.getElementById('fullName').value;
            const username = document.getElementById('username').value;
            const email = document.getElementById('email').value;
            const password = document.getElementById('password').value;
            const confirmPassword = document.getElementById('confirmPassword').value;

            if (password !== confirmPassword) {
                Toast.error('Passwords do not match');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Create Account';
                return;
            }

            const success = await authManager.register(username, email, password, fullName);
            if (success) {
                renderApp();
            }
        }

        submitBtn.disabled = false;
        submitBtn.textContent = isLogin ? 'Sign In' : 'Create Account';
    });

    // Switch auth type
    document.getElementById('switch-auth').addEventListener('click', (e) => {
        e.preventDefault();
        renderAuthPage(isLogin ? 'register' : 'login');
    });
}

// Create global auth manager
window.authManager = new AuthManager();
