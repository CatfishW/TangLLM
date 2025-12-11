"""
Image Annotation Service for Object Detection.
Parses coordinates from LLM responses and draws bounding boxes on images.
"""

import re
import os
import uuid
import io
import requests
from typing import List, Tuple, Optional
from PIL import Image, ImageDraw, ImageFont

from ..config import settings


class AnnotationService:
    """Service for annotating images with detection bounding boxes."""
    
    # Color name to RGB mapping
    COLOR_MAP = {
        'red': (255, 0, 0),
        'green': (0, 255, 0),
        'blue': (0, 0, 255),
        'yellow': (255, 255, 0),
        'cyan': (0, 255, 255),
        'magenta': (255, 0, 255),
        'orange': (255, 165, 0),
        'purple': (128, 0, 128),
        'pink': (255, 192, 203),
        'lime': (0, 255, 0),
        'white': (255, 255, 255),
        'black': (0, 0, 0),
    }
    
    # Default bounding box style
    DEFAULT_COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255), (0, 255, 255)]
    BOX_WIDTH = 3
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
        # Strip thinking content first - don't parse coordinates from model's internal reasoning
        # Remove everything between <think> and </think> tags
        clean_text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL | re.IGNORECASE)
        
        # Pattern to match individual coordinate boxes: [num,num,num,num]
        # This pattern finds all boxes regardless of outer array structure
        pattern = r'\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]'
        
        matches = re.findall(pattern, clean_text)
        
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
    
    def parse_colors_from_text(self, text: str, num_boxes: int) -> List[Tuple[int, int, int]]:
        """
        Extract color specifications from text and map them to bounding boxes.
        
        Looks for patterns like:
        - "player head in green" or "green rectangle"
        - "wheel in red" or "red box"
        
        The colors are matched in the order they appear in the text.
        
        Args:
            text: The combined user prompt and LLM response
            num_boxes: Number of bounding boxes to assign colors to
            
        Returns:
            List of RGB color tuples, one for each box
        """
        # Find all color mentions in order of appearance
        color_names = list(self.COLOR_MAP.keys())
        color_pattern = r'\b(' + '|'.join(color_names) + r')\b'
        
        matches = re.findall(color_pattern, text.lower())
        
        colors = []
        for match in matches:
            if match in self.COLOR_MAP:
                colors.append(self.COLOR_MAP[match])
        
        # Remove duplicates while preserving order
        seen = set()
        unique_colors = []
        for color in colors:
            if color not in seen:
                seen.add(color)
                unique_colors.append(color)
        
        # If we found colors, use them; otherwise use defaults
        if unique_colors:
            # Extend with defaults if not enough colors specified
            result = unique_colors[:num_boxes]
            while len(result) < num_boxes:
                # Cycle through unique colors or use defaults
                idx = len(result) % len(unique_colors)
                result.append(unique_colors[idx])
            return result
        else:
            # Use cycling default colors
            return [self.DEFAULT_COLORS[i % len(self.DEFAULT_COLORS)] for i in range(num_boxes)]
    
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
        image_source: str,
        coordinates: List[Tuple[int, int, int, int]],
        colors: Optional[List[Tuple[int, int, int]]] = None,
        labels: Optional[List[str]] = None,
        normalize: bool = True
    ) -> Image.Image:
        """
        Draw bounding boxes on an image.
        
        Args:
            image_source: Path to the source image OR URL to download from
            coordinates: List of (xmin, ymin, xmax, ymax) tuples
            colors: Optional list of RGB color tuples for each box
            labels: Optional labels for each bounding box
            normalize: Whether to check and convert normalized coordinates
            
        Returns:
            Annotated PIL Image
        """
        # Open image from file or URL
        if image_source.startswith('http'):
            # Download image from URL
            response = requests.get(image_source, timeout=30)
            response.raise_for_status()
            image = Image.open(io.BytesIO(response.content))
        else:
            image = Image.open(image_source)
        
        # Convert to RGB if necessary (for saving as JPEG)
        if image.mode in ('RGBA', 'P'):
            image = image.convert('RGB')
        
        width, height = image.size
        
        # Normalize coordinates if needed
        if normalize:
            coordinates = self.normalize_coordinates(coordinates, width, height)
        
        # Use provided colors or defaults
        if not colors:
            colors = [self.DEFAULT_COLORS[i % len(self.DEFAULT_COLORS)] for i in range(len(coordinates))]
        
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
            
            # Get color for this box
            box_color = colors[i] if i < len(colors) else self.DEFAULT_COLORS[0]
            
            # Draw rectangle
            draw.rectangle(
                [xmin, ymin, xmax, ymax],
                outline=box_color,
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
                    fill=box_color
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
        original_filename: Optional[str] = None,
        user_prompt: Optional[str] = None
    ) -> Optional[str]:
        """
        Main entry point: Parse coordinates from response and create annotated image.
        
        Args:
            response_text: LLM response text that may contain coordinates
            image_path: Path to the user's uploaded image
            user_id: User ID for saving the annotated image
            original_filename: Original filename for extension
            user_prompt: Original user prompt (for extracting color specifications)
            
        Returns:
            URL to annotated image, or None if no coordinates found
        """
    # Parse coordinates
        coordinates = self.parse_coordinates(response_text)
        
        print(f"[DEBUG ANNOTATION] Response text (first 500 chars): {response_text[:500]}")
        print(f"[DEBUG ANNOTATION] Parsed coordinates: {coordinates}")
        
        if not coordinates:
            print(f"[DEBUG ANNOTATION] No coordinates found in response")
            return None
        
        try:
            # Parse colors from user prompt (if provided) combined with response
            combined_text = (user_prompt or "") + " " + response_text
            colors = self.parse_colors_from_text(combined_text, len(coordinates))
            
            # Annotate image with colors
            annotated = self.annotate_image(image_path, coordinates, colors=colors)
            
            # Save and return URL
            return self.save_annotated_image(annotated, user_id, original_filename)
            
        except Exception as e:
            print(f"Error annotating image: {e}")
            return None
