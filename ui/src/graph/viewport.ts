/**
 * How every graph canvas moves: dragging the pane or scrolling (a mouse wheel, a Magic Mouse swipe,
 * a trackpad two-finger move) pans; pinching, or scrolling with ⌘ (Ctrl elsewhere) held, zooms.
 * React Flow's default turns every scroll into zoom, which on a Mac swipe feels like dragging
 * resizes the graph. The ⌘/Ctrl zoom key is React Flow's default zoomActivationKeyCode.
 */
export const canvasNavigation = {
  panOnDrag: true,
  panOnScroll: true,
  zoomOnScroll: false,
  zoomOnPinch: true,
} as const;
