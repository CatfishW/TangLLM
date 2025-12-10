# TangLLM

A full-stack ChatGPT-like web application with stunning animations, multimodal support (video/image/text), and Rowan University branding.

**Advisor:** Ying Tang  
**Developer:** Yanlai Wu  
**Institution:** Rowan University - Department of Electrical and Computer Engineering

![TangLLM](https://img.shields.io/badge/TangLLM-v1.0-gold?style=for-the-badge)
![Python](https://img.shields.io/badge/Python-3.10+-blue?style=for-the-badge)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-green?style=for-the-badge)

---

## ✨ Features

### Core Features
- 🤖 **AI Chat** - Powered by Qwen3-VL multimodal LLM
- 🖼️ **Image Support** - Upload and analyze images
- 🎬 **Video Support** - Process and understand videos
- 📝 **Markdown Rendering** - Rich text formatting in responses
- 🔄 **Streaming Responses** - Real-time token streaming

### Advanced Features (Beyond ChatGPT/Gemini)
- 🎤 **Voice Input** - Speech-to-text using Web Speech API
- 🔊 **Voice Output** - Text-to-speech for responses
- 🌿 **Conversation Branching** - Edit previous messages and create branches
- 📥 **Export Conversations** - Download as Markdown or JSON
- 📚 **System Prompt Templates** - Customize assistant behavior
- 📊 **Analytics** - Track token usage and response times
- ⌨️ **Keyboard Shortcuts** - Power user productivity
- 🌙 **Dark/Light Theme** - Toggle between color schemes
- ⭐ **Message Bookmarks** - Save important messages
- 🔍 **Search** - Find across all conversations
- 🔗 **Share Conversations** - Generate shareable links
- 😊 **Message Reactions** - React to messages

### Technical Excellence
- 🏗️ **High Cohesion, Low Coupling** - Clean architecture
- ⚡ **High Performance** - Optimized animations at 60fps
- 🎨 **Premium Design** - Rowan University themed with glassmorphism
- ✨ **Particle Effects** - Interactive canvas-based particles
- 📱 **Responsive** - Works on desktop and mobile

---

## 🚀 Quick Start

### Prerequisites
- Python 3.10+
- Node.js (optional, for development)

### Installation

1. **Clone the repository**
```bash
cd TangLLM
```

2. **Set up the backend**
```bash
cd backend
pip install -r requirements.txt
```

3. **Run the server**
```bash
python run.py
```

4. **Open in browser**
```
http://localhost:8000
```

---

## 📁 Project Structure

```
TangLLM/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI application
│   │   ├── config.py            # Configuration settings
│   │   ├── database.py          # Database setup
│   │   ├── models/              # SQLAlchemy models
│   │   ├── schemas/             # Pydantic schemas
│   │   ├── routers/             # API routes
│   │   ├── services/            # Business logic
│   │   └── utils/               # Utilities
│   ├── uploads/                 # Uploaded files
│   ├── requirements.txt
│   └── run.py
├── frontend/
│   ├── index.html               # Main entry
│   ├── css/
│   │   ├── design-system.css    # Design tokens
│   │   ├── animations.css       # Animation library
│   │   ├── components.css       # UI components
│   │   └── pages.css            # Page layouts
│   └── js/
│       ├── app.js               # Main application
│       ├── api.js               # API client
│       ├── auth.js              # Authentication
│       ├── chat.js              # Chat functionality
│       ├── particles.js         # Particle effects
│       ├── settings.js          # Settings manager
│       └── utils.js             # Utilities
└── README.md
```

---

## 🎨 Design System

### Rowan University Colors
| Color | Hex | Usage |
|-------|-----|-------|
| Brown (Primary) | `#5B1400` | Accents, secondary elements |
| Gold (Primary) | `#FFCE00` | Primary actions, highlights |
| Background | `#0a0a0f` | Dark background |

### Typography
- **Headings:** Source Serif Pro
- **Body:** Source Sans Pro
- **Code:** JetBrains Mono

---

## 🔌 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login and get tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/auth/me` | Get current user |
| PUT | `/api/auth/password` | Change password |

### Chat
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send message (streaming) |

### Conversations
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create conversation |
| GET | `/api/conversations/{id}` | Get conversation |
| PUT | `/api/conversations/{id}` | Update conversation |
| DELETE | `/api/conversations/{id}` | Delete conversation |
| POST | `/api/conversations/{id}/branch` | Branch conversation |
| GET | `/api/conversations/{id}/export` | Export conversation |

### Files
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/files/upload` | Upload file |
| GET | `/api/files/{path}` | Get file |
| DELETE | `/api/files/{path}` | Delete file |

### Settings
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/settings` | Get user settings |
| PUT | `/api/settings` | Update settings |
| POST | `/api/settings/reset` | Reset to defaults |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Enter` | Send message |
| `Ctrl + N` | New chat |
| `Ctrl + ,` | Open settings |
| `Ctrl + /` | Show shortcuts |
| `Escape` | Close modal |

---

## 🔧 Configuration

### Environment Variables

Create a `.env` file in the `backend` directory:

```env
# Application
DEBUG=True
SECRET_KEY=your-secret-key

# LLM API
DEFAULT_API_BASE=https://game.agaii.org/mllm/v1
DEFAULT_MODEL_ID=Qwen/Qwen3-VL-30B-A3B-Instruct-FP8

# Server
HOST=0.0.0.0
PORT=8000
```

---

## 📜 License

This project is created for educational purposes at Rowan University.

---

## 🙏 Acknowledgments

- **Advisor:** Dr. Ying Tang - Rowan University
- **Model:** Qwen3-VL by Alibaba Cloud
- **Inspiration:** ChatGPT, Gemini, Claude

---

<p align="center">
  <strong>TangLLM</strong> - Rowan University AI Chat<br>
  Made with ❤️ by Yanlai Wu
</p>
