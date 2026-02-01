import { MotdInfo } from '../../types/index.js';

const COLOR_CODES: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
  'black': '#000000', 'dark_blue': '#0000AA', 'dark_green': '#00AA00', 'dark_aqua': '#00AAAA',
  'dark_red': '#AA0000', 'dark_purple': '#AA00AA', 'gold': '#FFAA00', 'gray': '#AAAAAA',
  'dark_gray': '#555555', 'blue': '#5555FF', 'green': '#55FF55', 'aqua': '#55FFFF',
  'red': '#FF5555', 'light_purple': '#FF55FF', 'yellow': '#FFFF55', 'white': '#FFFFFF',
};

const JSON_FORMAT_MAP: Record<string, string> = {
  'bold': 'font-weight: bold;',
  'italic': 'font-style: italic;',
  'underlined': 'text-decoration: underline;',
  'strikethrough': 'text-decoration: line-through;',
  'obfuscated': '',
};

// A component can be either an object with text/extra/color/etc, OR a plain string
type MotdComponent = string | {
  text?: string;
  extra?: MotdComponent[];
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
  obfuscated?: boolean;
  [key: string]: unknown;
};

export function parseMotd(raw: string | MotdComponent): MotdInfo {
  // If it's already an object or string (JSON format), render it directly
  if (typeof raw !== 'string' || (typeof raw === 'string' && raw.trim().startsWith('{'))) {
    let component: MotdComponent;

    if (typeof raw === 'string') {
      try {
        component = JSON.parse(raw);
      } catch {
        // Not valid JSON, treat as legacy string
        return {
          raw: raw,
          clean: cleanMotd(raw),
          html: motdToHtml(raw),
        };
      }
    } else {
      component = raw;
    }

    const rawText = jsonToRawText(component);
    return {
      raw: rawText,
      clean: rawText.replace(/§[0-9a-fk-or]/gi, ''),
      html: jsonToHtml(component),
    };
  }

  // Legacy String Handling
  return {
    raw: raw,
    clean: cleanMotd(raw),
    html: motdToHtml(raw),
  };
}

function jsonToRawText(component: MotdComponent): string {
  // Handle plain string components
  if (typeof component === 'string') {
    return component;
  }

  let text = '';
  if (component.text) text += component.text;
  if (component.extra) {
    for (const extra of component.extra) {
      text += jsonToRawText(extra);
    }
  }
  return text;
}

function jsonToHtml(component: MotdComponent): string {
  // Handle plain string components (like "\n")
  if (typeof component === 'string') {
    return escapeHtml(component);
  }

  let style = '';

  // Color
  if (component.color) {
    let colorHex = component.color;
    // Check if it's a named color
    if (COLOR_CODES[colorHex.toLowerCase()]) {
      colorHex = COLOR_CODES[colorHex.toLowerCase()];
    }
    // If it's a hex code (e.g., #FFFFFF), use it
    if (colorHex.startsWith('#')) {
      style += `color: ${colorHex};`;
    }
  }

  // Formats
  if (component.bold) style += JSON_FORMAT_MAP['bold'];
  if (component.italic) style += JSON_FORMAT_MAP['italic'];
  if (component.underlined) style += JSON_FORMAT_MAP['underlined'];
  if (component.strikethrough) style += JSON_FORMAT_MAP['strikethrough'];

  // Build HTML
  let html = '';
  const textContent = component.text ? escapeHtml(component.text) : '';

  if (style) {
    html += `<span style="${style}">`;
  }

  html += textContent;

  // Recursively handle extra
  if (component.extra) {
    for (const extra of component.extra) {
      html += jsonToHtml(extra);
    }
  }

  if (style) {
    html += `</span>`;
  }

  return html;
}

export function cleanMotd(raw: string): string {
  return raw.replace(/§[0-9a-fk-or]/gi, '');
}

export function motdToHtml(raw: string): string {
  let html = '';
  let currentColor: string | null = null;
  let state = {
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
  };

  const chars = raw.split('');
  let buffer = '';

  const flush = () => {
    if (buffer) {
      let style = '';
      if (currentColor) style += `color: ${currentColor};`;
      if (state.bold) style += 'font-weight: bold;';
      if (state.italic) style += 'font-style: italic;';
      if (state.underline) style += 'text-decoration: underline;';
      if (state.strikethrough) style += 'text-decoration: line-through;';

      const escapedBuffer = escapeHtml(buffer);

      if (style) {
        html += `<span style="${style}">${escapedBuffer}</span>`;
      } else {
        html += escapedBuffer;
      }
      buffer = '';
    }
  };

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '§' && i + 1 < chars.length) {
      const code = chars[i + 1].toLowerCase();
      flush();
      i++;

      if (COLOR_CODES[code]) {
        currentColor = COLOR_CODES[code];
        state = { bold: false, italic: false, underline: false, strikethrough: false };
      } else if (code === 'r') {
        currentColor = null;
        state = { bold: false, italic: false, underline: false, strikethrough: false };
      } else if (code === 'l') state.bold = true;
      else if (code === 'o') state.italic = true;
      else if (code === 'n') state.underline = true;
      else if (code === 'm') state.strikethrough = true;
    } else {
      buffer += chars[i];
    }
  }
  flush();

  return html;
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br>');
}
