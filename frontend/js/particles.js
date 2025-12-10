/**
 * TangLLM Particle System
 * High-performance canvas-based particle effects
 */

class ParticleSystem {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.canvas.id = canvasId;
            document.body.prepend(this.canvas);
        }

        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.mouseX = 0;
        this.mouseY = 0;
        this.isRunning = false;

        // Configuration
        this.config = {
            particleCount: 80,
            particleMinSize: 1,
            particleMaxSize: 3,
            particleColor: { r: 255, g: 206, b: 0 }, // Gold
            particleOpacity: 0.6,
            connectionDistance: 150,
            connectionOpacity: 0.15,
            mouseRadius: 200,
            mouseForce: 0.02,
            velocityMax: 0.5,
            velocityDecay: 0.98
        };

        this.init();
    }

    init() {
        this.resize();
        this.createParticles();
        this.bindEvents();
        this.start();
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.canvas.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            z-index: -1;
        `;
    }

    createParticles() {
        this.particles = [];

        for (let i = 0; i < this.config.particleCount; i++) {
            this.particles.push(this.createParticle());
        }
    }

    createParticle() {
        const size = this.config.particleMinSize +
            Math.random() * (this.config.particleMaxSize - this.config.particleMinSize);

        return {
            x: Math.random() * this.canvas.width,
            y: Math.random() * this.canvas.height,
            vx: (Math.random() - 0.5) * this.config.velocityMax,
            vy: (Math.random() - 0.5) * this.config.velocityMax,
            size: size,
            opacity: 0.3 + Math.random() * 0.7,
            pulseOffset: Math.random() * Math.PI * 2
        };
    }

    bindEvents() {
        window.addEventListener('resize', () => {
            this.resize();
            this.createParticles();
        });

        document.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;
        });

        // Visibility change - pause when tab is hidden
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.stop();
            } else {
                this.start();
            }
        });
    }

    updateParticle(particle, time) {
        // Mouse interaction
        const dx = this.mouseX - particle.x;
        const dy = this.mouseY - particle.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < this.config.mouseRadius && distance > 0) {
            const force = (this.config.mouseRadius - distance) / this.config.mouseRadius;
            particle.vx -= (dx / distance) * force * this.config.mouseForce;
            particle.vy -= (dy / distance) * force * this.config.mouseForce;
        }

        // Apply velocity
        particle.x += particle.vx;
        particle.y += particle.vy;

        // Apply decay
        particle.vx *= this.config.velocityDecay;
        particle.vy *= this.config.velocityDecay;

        // Add subtle floating motion
        particle.vx += Math.sin(time * 0.001 + particle.pulseOffset) * 0.01;
        particle.vy += Math.cos(time * 0.001 + particle.pulseOffset) * 0.01;

        // Wrap around edges
        if (particle.x < 0) particle.x = this.canvas.width;
        if (particle.x > this.canvas.width) particle.x = 0;
        if (particle.y < 0) particle.y = this.canvas.height;
        if (particle.y > this.canvas.height) particle.y = 0;
    }

    drawParticle(particle, time) {
        const { r, g, b } = this.config.particleColor;

        // Pulse effect
        const pulse = 0.5 + Math.sin(time * 0.002 + particle.pulseOffset) * 0.5;
        const opacity = particle.opacity * this.config.particleOpacity * (0.7 + pulse * 0.3);

        // Glow effect
        const gradient = this.ctx.createRadialGradient(
            particle.x, particle.y, 0,
            particle.x, particle.y, particle.size * 3
        );
        gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${opacity})`);
        gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${opacity * 0.3})`);
        gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

        this.ctx.beginPath();
        this.ctx.arc(particle.x, particle.y, particle.size * 3, 0, Math.PI * 2);
        this.ctx.fillStyle = gradient;
        this.ctx.fill();

        // Core
        this.ctx.beginPath();
        this.ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
        this.ctx.fill();
    }

    drawConnections() {
        const { r, g, b } = this.config.particleColor;

        for (let i = 0; i < this.particles.length; i++) {
            for (let j = i + 1; j < this.particles.length; j++) {
                const p1 = this.particles[i];
                const p2 = this.particles[j];

                const dx = p1.x - p2.x;
                const dy = p1.y - p2.y;
                const distance = Math.sqrt(dx * dx + dy * dy);

                if (distance < this.config.connectionDistance) {
                    const opacity = (1 - distance / this.config.connectionDistance) *
                        this.config.connectionOpacity;

                    this.ctx.beginPath();
                    this.ctx.moveTo(p1.x, p1.y);
                    this.ctx.lineTo(p2.x, p2.y);
                    this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${opacity})`;
                    this.ctx.lineWidth = 0.5;
                    this.ctx.stroke();
                }
            }
        }
    }

    render(time) {
        if (!this.isRunning) return;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Update and draw particles
        for (const particle of this.particles) {
            this.updateParticle(particle, time);
            this.drawParticle(particle, time);
        }

        // Draw connections
        this.drawConnections();

        // Request next frame
        requestAnimationFrame((t) => this.render(t));
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        requestAnimationFrame((t) => this.render(t));
    }

    stop() {
        this.isRunning = false;
    }

    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.createParticles();
    }
}

// Initialize particle system
let particleSystem;

document.addEventListener('DOMContentLoaded', () => {
    particleSystem = new ParticleSystem('particle-canvas');
});

// Export for use in other modules
window.ParticleSystem = ParticleSystem;
window.getParticleSystem = () => particleSystem;
