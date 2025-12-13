"""
Image Annotation Service for Object Detection.
Parses coordinates from LLM responses and draws bounding boxes on images.
Supports class labels with pretty styling.
"""

import re
import os
import uuid
import io
import json
import requests
from typing import List, Tuple, Optional, Dict, Any
from PIL import Image, ImageDraw, ImageFont

from ..config import settings


class AnnotationService:
    """Service for annotating images with detection bounding boxes and labels."""
    
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
    
    # Pretty category-specific color palette (vibrant, distinguishable)
    CATEGORY_COLORS = {
        'head': (255, 107, 107),       # Coral Red
        'face': (255, 107, 107),       # Coral Red
        'hand': (72, 201, 176),        # Teal
        'hands': (72, 201, 176),       # Teal
        'man': (86, 156, 214),         # Sky Blue
        'person': (86, 156, 214),      # Sky Blue
        'woman': (255, 154, 162),      # Rose Pink
        'glasses': (187, 134, 252),    # Lavender Purple
        'eye': (255, 209, 102),        # Golden Yellow
        'eyes': (255, 209, 102),       # Golden Yellow
        'body': (129, 199, 132),       # Mint Green
        'arm': (255, 183, 77),         # Warm Orange
        'leg': (100, 181, 246),        # Light Blue
        'foot': (174, 213, 129),       # Light Green
        'car': (239, 83, 80),          # Crimson
        'dog': (255, 167, 38),         # Orange
        'cat': (171, 71, 188),         # Purple
        'bird': (66, 165, 245),        # Blue
        'phone': (78, 205, 196),       # Cyan
        'laptop': (69, 90, 100),       # Dark Gray
        'cup': (139, 195, 74),         # Lime
        'bottle': (38, 166, 154),      # Teal
        'chair': (121, 85, 72),        # Brown
        'table': (158, 158, 158),      # Gray
    }
    
    # Default colors for unknown categories (cycle through these)
    DEFAULT_COLORS = [
        (255, 107, 107),  # Coral
        (72, 201, 176),   # Teal
        (86, 156, 214),   # Blue
        (255, 183, 77),   # Orange
        (187, 134, 252),  # Purple
        (129, 199, 132),  # Green
        (255, 154, 162),  # Pink
        (255, 209, 102),  # Yellow
    ]
    
    BOX_WIDTH = 3
    LABEL_TEXT_COLOR = (255, 255, 255)  # White
    LABEL_PADDING = 6
    LABEL_FONT_SIZE = 18
    
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
    
    def parse_labeled_objects(self, text: str) -> Optional[List[Tuple[str, Tuple[int, int, int, int]]]]:
        """
        Parse JSON-formatted detection results with labels and bounding boxes.
        
        Supports formats:
        - [{"label": "head", "bbox": [x1, y1, x2, y2]}, ...]
        - [{"label": "head", "box": [x1, y1, x2, y2]}, ...]
        - [{"category": "head", "bbox": [x1, y1, x2, y2]}, ...]
        - [{"class": "head", "bbox": [x1, y1, x2, y2]}, ...]
        - {"head": [[x1, y1, x2, y2], ...], "hand": [[x1, y1, x2, y2], ...]}
        
        Returns list of (label, (xmin, ymin, xmax, ymax)) tuples, or None if no labeled objects found.
        """
        # Strip thinking content first
        clean_text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL | re.IGNORECASE)
        
        labeled_objects = []
        
        # Try to find JSON array or object in the text
        # Pattern 1: Array of objects with label and bbox/box
        json_array_pattern = r'\[\s*\{[^}]*(?:label|category|class)[^}]*\}(?:\s*,\s*\{[^}]*\})*\s*\]'
        json_matches = re.findall(json_array_pattern, clean_text, re.DOTALL | re.IGNORECASE)
        
        for json_str in json_matches:
            try:
                # Clean up the JSON string (handle potential issues)
                json_str = json_str.replace("'", '"')
                data = json.loads(json_str)
                
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict):
                            # Get label from various possible keys
                            label = item.get('label') or item.get('category') or item.get('class') or item.get('name') or 'object'
                            # Get bbox from various possible keys
                            bbox = item.get('bbox') or item.get('box') or item.get('bounding_box') or item.get('coordinates')
                            
                            if bbox and len(bbox) == 4:
                                try:
                                    coords = tuple(int(x) for x in bbox)
                                    if coords[2] > coords[0] and coords[3] > coords[1]:
                                        labeled_objects.append((str(label), coords))
                                except (ValueError, TypeError):
                                    continue
            except json.JSONDecodeError:
                continue
        
        # Pattern 2: Try to match individual labeled objects inline
        # e.g., "head": [100, 200, 300, 400] or head: [100, 200, 300, 400]
        inline_pattern = r'["\']?(\w+)["\']?\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]'
        inline_matches = re.findall(inline_pattern, clean_text)
        
        for match in inline_matches:
            try:
                label = match[0]
                # Skip common non-label keys
                if label.lower() in ['bbox', 'box', 'bounding_box', 'coordinates', 'x', 'y', 'width', 'height']:
                    continue
                coords = tuple(int(x) for x in match[1:5])
                if coords[2] > coords[0] and coords[3] > coords[1]:
                    # Avoid duplicate entries
                    if (label, coords) not in labeled_objects:
                        labeled_objects.append((label, coords))
            except (ValueError, IndexError):
                continue
        
        # Pattern 3: Try to find object format {"category": {"boxes": [[...], [...]]}}
        # or {"head": [[100,200,300,400]], "hand": [[...], [...]]}
        try:
            # Look for JSON objects in the text
            brace_pattern = r'\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]+\}'
            brace_matches = re.findall(brace_pattern, clean_text)
            
            for json_str in brace_matches:
                try:
                    json_str = json_str.replace("'", '"')
                    data = json.loads(json_str)
                    
                    if isinstance(data, dict):
                        for key, value in data.items():
                            # Skip metadata keys
                            if key.lower() in ['bbox', 'box', 'image', 'width', 'height', 'size']:
                                continue
                            
                            # Value could be a list of bboxes or a single bbox
                            if isinstance(value, list):
                                if len(value) == 4 and all(isinstance(x, (int, float)) for x in value):
                                    # Single bbox
                                    coords = tuple(int(x) for x in value)
                                    if coords[2] > coords[0] and coords[3] > coords[1]:
                                        labeled_objects.append((key, coords))
                                elif all(isinstance(x, list) for x in value):
                                    # List of bboxes
                                    for bbox in value:
                                        if len(bbox) == 4:
                                            coords = tuple(int(x) for x in bbox)
                                            if coords[2] > coords[0] and coords[3] > coords[1]:
                                                labeled_objects.append((key, coords))
                except json.JSONDecodeError:
                    continue
        except Exception:
            pass
        
        return labeled_objects if labeled_objects else None
    
    def get_color_for_label(self, label: str, index: int = 0) -> Tuple[int, int, int]:
        """Get a color for a category label, using predefined colors or cycling through defaults."""
        label_lower = label.lower().strip()
        
        if label_lower in self.CATEGORY_COLORS:
            return self.CATEGORY_COLORS[label_lower]
        
        # Use consistent color for same label by hashing
        hash_val = sum(ord(c) for c in label_lower)
        return self.DEFAULT_COLORS[hash_val % len(self.DEFAULT_COLORS)]
    
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
            # Check if this is a local server URL (same server API files)
            # Convert /api/files/user_id/filename to local path
            api_match = re.search(r'/api/files/(\d+)/([^/?]+)', image_source)
            if api_match:
                # It's a local API file URL - read directly from disk
                user_id = api_match.group(1)
                filename = api_match.group(2)
                local_path = os.path.join(settings.UPLOAD_DIR, user_id, filename)
                print(f"[DEBUG ANNOTATION] Converting API URL to local path: {local_path}")
                if os.path.exists(local_path):
                    image = Image.open(local_path)
                else:
                    raise FileNotFoundError(f"Local file not found: {local_path}")
            else:
                # External URL - download with longer timeout
                print(f"[DEBUG ANNOTATION] Downloading external image: {image_source}")
                response = requests.get(image_source, timeout=60)
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
        
        # Try to get a font for labels (use larger font for better readability)
        try:
            font = ImageFont.truetype("arial.ttf", self.LABEL_FONT_SIZE)
        except (IOError, OSError):
            try:
                # Try common font paths on different systems
                font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", self.LABEL_FONT_SIZE)
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
                text_bbox = draw.textbbox((0, 0), label, font=font)
                text_width = text_bbox[2] - text_bbox[0]
                text_height = text_bbox[3] - text_bbox[1]
                
                padding = self.LABEL_PADDING
                
                # Calculate label position (prefer above box, fall back to below)
                label_height = text_height + padding * 2
                label_width = text_width + padding * 2
                
                if ymin > label_height + 4:
                    # Place above the box
                    label_x = xmin
                    label_y = ymin - label_height - 2
                else:
                    # Place below the box (or inside at bottom if no space)
                    if ymax + label_height + 4 < height:
                        label_x = xmin
                        label_y = ymax + 2
                    else:
                        # Place inside at top
                        label_x = xmin + 2
                        label_y = ymin + 2
                
                # Clamp label position to image bounds
                label_x = max(0, min(label_x, width - label_width))
                label_y = max(0, min(label_y, height - label_height))
                
                # Draw shadow for depth effect
                shadow_offset = 2
                shadow_color = (0, 0, 0, 128)  # Semi-transparent black
                draw.rectangle(
                    [label_x + shadow_offset, label_y + shadow_offset, 
                     label_x + label_width + shadow_offset, label_y + label_height + shadow_offset],
                    fill=(30, 30, 30)
                )
                
                # Draw label background with rounded appearance (using rectangle for compatibility)
                draw.rectangle(
                    [label_x, label_y, label_x + label_width, label_y + label_height],
                    fill=box_color
                )
                
                # Draw subtle border for definition
                border_color = tuple(max(0, c - 40) for c in box_color)
                draw.rectangle(
                    [label_x, label_y, label_x + label_width, label_y + label_height],
                    outline=border_color,
                    width=1
                )
                
                # Draw label text with slight offset for better centering
                text_x = label_x + padding
                text_y = label_y + padding - 2  # Slight adjustment for visual centering
                
                # Draw text shadow for readability
                draw.text(
                    (text_x + 1, text_y + 1),
                    label,
                    fill=(0, 0, 0),
                    font=font
                )
                
                # Draw main text
                draw.text(
                    (text_x, text_y),
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
        print(f"[DEBUG ANNOTATION] Response text (first 500 chars): {response_text[:500]}")
        
        # First try to parse labeled objects (JSON format with class labels)
        labeled_objects = self.parse_labeled_objects(response_text)
        
        coordinates = []
        labels = []
        colors = []
        
        if labeled_objects:
            print(f"[DEBUG ANNOTATION] Found {len(labeled_objects)} labeled objects")
            for label, coords in labeled_objects:
                coordinates.append(coords)
                labels.append(label)
                colors.append(self.get_color_for_label(label))
        else:
            # Fall back to simple coordinate parsing (unlabeled)
            coordinates = self.parse_coordinates(response_text)
            
            if not coordinates:
                print(f"[DEBUG ANNOTATION] No coordinates found in response")
                return None
            
            print(f"[DEBUG ANNOTATION] Found {len(coordinates)} unlabeled coordinates")
            
            # Parse colors from user prompt (if provided) combined with response
            combined_text = (user_prompt or "") + " " + response_text
            colors = self.parse_colors_from_text(combined_text, len(coordinates))
            labels = None  # No labels for simple coordinate format
        
        if not coordinates:
            print(f"[DEBUG ANNOTATION] No valid coordinates to annotate")
            return None
        
        print(f"[DEBUG ANNOTATION] Final coordinates: {coordinates}")
        print(f"[DEBUG ANNOTATION] Labels: {labels}")
        
        try:
            # Annotate image with labels and colors
            annotated = self.annotate_image(
                image_path, 
                coordinates, 
                colors=colors,
                labels=labels
            )
            
            # Save and return URL
            return self.save_annotated_image(annotated, user_id, original_filename)
            
        except Exception as e:
            print(f"Error annotating image: {e}")
            import traceback
            traceback.print_exc()
            return None
