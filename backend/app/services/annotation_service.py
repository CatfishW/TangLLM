"""
Image Annotation Service for Object Detection.
Parses coordinates from LLM responses and draws bounding boxes on images.
"""

import re
import os
import uuid
from typing import List, Tuple, Optional
from PIL import Image, ImageDraw, ImageFont

from ..config import settings


class AnnotationService:
    """Service for annotating images with detection bounding boxes."""
    
    # Default bounding box style
    BOX_COLOR = (255, 0, 0)  # Red
    BOX_WIDTH = 3
    LABEL_BG_COLOR = (255, 0, 0, 180)  # Semi-transparent red
    LABEL_TEXT_COLOR = (255, 255, 255)  # White
    
    @staticmethod
    def parse_coordinates(text: str) -> Optional[List[Tuple[int, int, int, int]]]:
        """
        Extract coordinate arrays from LLM response text.
        
        Supports formats:
        - [[x1,y1,x2,y2]] - single box
        - [[x1,y1,x2,y2], [x3,y3,x4,y4]] - multiple boxes
        - The coordinates in the third chart are [[764,6,998,870]]
        
        Returns list of (xmin, ymin, xmax, ymax) tuples, or None if no coordinates found.
        """
        # Pattern to match individual coordinate boxes: [num,num,num,num]
        # This pattern finds all boxes regardless of outer array structure
        pattern = r'\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]'
        
        matches = re.findall(pattern, text)
        
        if not matches:
            return None
        
        coordinates = []
        for match in matches:
            try:
                coords = tuple(int(x) for x in match)
                # Validate: xmax > xmin and ymax > ymin
                if coords[2] > coords[0] and coords[3] > coords[1]:
                    coordinates.append(coords)
            except (ValueError, IndexError):
                continue
        
        return coordinates if coordinates else None
    
    @staticmethod
    def normalize_coordinates(
        coords: List[Tuple[int, int, int, int]], 
        image_width: int, 
        image_height: int,
        source_range: int = 1000
    ) -> List[Tuple[int, int, int, int]]:
        """
        Convert coordinates from normalized range (0-1000) to absolute pixels.
        Only applies if coordinates appear to be in normalized range.
        """
        normalized = []
        for xmin, ymin, xmax, ymax in coords:
            # Check if coordinates are likely normalized (max value around 1000)
            if max(xmin, ymin, xmax, ymax) <= source_range:
                # Convert to absolute
                xmin = int(xmin * image_width / source_range)
                ymin = int(ymin * image_height / source_range)
                xmax = int(xmax * image_width / source_range)
                ymax = int(ymax * image_height / source_range)
            
            normalized.append((xmin, ymin, xmax, ymax))
        
        return normalized
    
    def annotate_image(
        self,
        image_path: str,
        coordinates: List[Tuple[int, int, int, int]],
        labels: Optional[List[str]] = None,
        normalize: bool = True
    ) -> Image.Image:
        """
        Draw bounding boxes on an image.
        
        Args:
            image_path: Path to the source image
            coordinates: List of (xmin, ymin, xmax, ymax) tuples
            labels: Optional labels for each bounding box
            normalize: Whether to check and convert normalized coordinates
            
        Returns:
            Annotated PIL Image
        """
        # Open image
        image = Image.open(image_path)
        
        # Convert to RGB if necessary (for saving as JPEG)
        if image.mode in ('RGBA', 'P'):
            image = image.convert('RGB')
        
        width, height = image.size
        
        # Normalize coordinates if needed
        if normalize:
            coordinates = self.normalize_coordinates(coordinates, width, height)
        
        # Create drawing context
        draw = ImageDraw.Draw(image)
        
        # Try to get a font for labels
        try:
            font = ImageFont.truetype("arial.ttf", 16)
        except (IOError, OSError):
            font = ImageFont.load_default()
        
        # Draw bounding boxes
        for i, (xmin, ymin, xmax, ymax) in enumerate(coordinates):
            # Clamp coordinates to image bounds
            xmin = max(0, min(xmin, width - 1))
            ymin = max(0, min(ymin, height - 1))
            xmax = max(0, min(xmax, width))
            ymax = max(0, min(ymax, height))
            
            # Draw rectangle
            draw.rectangle(
                [xmin, ymin, xmax, ymax],
                outline=self.BOX_COLOR,
                width=self.BOX_WIDTH
            )
            
            # Draw label if provided
            if labels and i < len(labels):
                label = labels[i]
                
                # Get text size
                bbox = draw.textbbox((0, 0), label, font=font)
                text_width = bbox[2] - bbox[0]
                text_height = bbox[3] - bbox[1]
                
                # Draw label background
                label_x = xmin
                label_y = ymin - text_height - 4 if ymin > text_height + 4 else ymax + 2
                
                draw.rectangle(
                    [label_x, label_y, label_x + text_width + 8, label_y + text_height + 4],
                    fill=self.BOX_COLOR
                )
                
                # Draw label text
                draw.text(
                    (label_x + 4, label_y + 2),
                    label,
                    fill=self.LABEL_TEXT_COLOR,
                    font=font
                )
        
        return image
    
    def save_annotated_image(
        self,
        image: Image.Image,
        user_id: int,
        original_filename: Optional[str] = None
    ) -> str:
        """
        Save annotated image to uploads directory.
        
        Args:
            image: PIL Image to save
            user_id: User ID for organizing uploads
            original_filename: Original filename (optional, for extension)
            
        Returns:
            URL path to the saved image
        """
        # Generate unique filename
        ext = ".jpg"
        if original_filename:
            _, ext = os.path.splitext(original_filename)
            if ext.lower() not in ['.jpg', '.jpeg', '.png', '.gif', '.webp']:
                ext = ".jpg"
        
        filename = f"annotated_{uuid.uuid4().hex[:12]}{ext}"
        
        # Ensure user directory exists
        user_dir = os.path.join(settings.UPLOAD_DIR, str(user_id))
        os.makedirs(user_dir, exist_ok=True)
        
        # Save image
        save_path = os.path.join(user_dir, filename)
        
        # Determine format
        save_format = "JPEG" if ext.lower() in ['.jpg', '.jpeg'] else ext[1:].upper()
        if save_format == "JPG":
            save_format = "JPEG"
        
        image.save(save_path, format=save_format, quality=90)
        
        # Return URL
        return f"/api/files/{user_id}/{filename}"
    
    def process_detection_response(
        self,
        response_text: str,
        image_path: str,
        user_id: int,
        original_filename: Optional[str] = None
    ) -> Optional[str]:
        """
        Main entry point: Parse coordinates from response and create annotated image.
        
        Args:
            response_text: LLM response text that may contain coordinates
            image_path: Path to the user's uploaded image
            user_id: User ID for saving the annotated image
            original_filename: Original filename for extension
            
        Returns:
            URL to annotated image, or None if no coordinates found
        """
        # Parse coordinates
        coordinates = self.parse_coordinates(response_text)
        
        if not coordinates:
            return None
        
        try:
            # Annotate image
            annotated = self.annotate_image(image_path, coordinates)
            
            # Save and return URL
            return self.save_annotated_image(annotated, user_id, original_filename)
            
        except Exception as e:
            print(f"Error annotating image: {e}")
            return None
