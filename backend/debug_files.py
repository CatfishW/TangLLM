import os
import sys
from pathlib import Path

# Add backend to path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.config import settings
from app.services.file_service import FileService

def debug_files():
    print(f"Current Working Directory: {os.getcwd()}")
    print(f"Configured UPLOAD_DIR: {settings.UPLOAD_DIR}")
    print(f"Absolute UPLOAD_DIR: {os.path.abspath(settings.UPLOAD_DIR)}")
    
    upload_path = Path(settings.UPLOAD_DIR)
    
    if not upload_path.exists():
        print(f"ERROR: Upload directory does not exist!")
    else:
        print(f"Upload directory exists.")
        print("Listing contents:")
        for root, dirs, files in os.walk(upload_path):
            level = root.replace(str(upload_path), '').count(os.sep)
            indent = ' ' * 4 * (level)
            print(f"{indent}{os.path.basename(root)}/")
            for f in files:
                print(f"{indent}    {f} (Size: {os.path.getsize(os.path.join(root, f))} bytes)")

if __name__ == "__main__":
    debug_files()
