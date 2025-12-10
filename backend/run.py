"""
TangLLM Backend Runner
Run with: python run.py
"""

import uvicorn
from app.config import settings


if __name__ == "__main__":
    print(f"""
    ╔══════════════════════════════════════════════════════════╗
    ║                       TangLLM                            ║
    ║          ChatGPT-like Web Application                    ║
    ║                                                          ║
    ║   Advisor: Ying Tang                                     ║
    ║   Developer: Yanlai Wu                                   ║
    ║                                                          ║
    ║   Rowan University - Dept. of Electrical & Computer Eng.  ║
    ╚══════════════════════════════════════════════════════════╝
    
    Starting server at http://{settings.HOST}:{settings.PORT}
    
    API Documentation: http://localhost:{settings.PORT}/docs
    """)
    
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        log_level="info"
    )
