import { MotdInfo } from '../../types/index.js';

const COLOR_CODES: Record<string, string> = {
  '0': '#000000', '1': '#0000AA', '2': '#00AA00', '3': '#00AAAA',
  '4': '#AA0000', '5': '#AA00AA', '6': '#FFAA00', '7': '#AAAAAA',
  '8': '#555555', '9': '#5555FF', 'a': '#55FF55', 'b': '#55FFFF',
  'c': '#FF5555', 'd': '#FF55FF', 'e': '#FFFF55', 'f': '#FFFFFF',
};

const FORMAT_CODES: Record<string, { open: string; close: string }> = {
  'l': { open: '<b>', close: '</b>' },
  'o': { open: '<i>', close: '</i>' },
  'n': { open: '<u>', close: '</u>' },
  'm': { open: '<s>', close: '</s>' },
};

export function parseMotd(raw: string | MotdComponent): MotdInfo {
  const rawStr = typeof raw === 'string' ? raw : componentToRaw(raw);
  return {
    raw: rawStr,
    clean: cleanMotd(rawStr),
    html: motdToHtml(rawStr),
  };
}

interface MotdComponent {
  text?: string;
  extra?: MotdComponent[];
  color?: string;
  bold?: boolean;
  italic?: boolean;
  underlined?: boolean;
  strikethrough?: boolean;
}

function componentToRaw(component: MotdComponent): string {
  let result = '';
  if (component.color) {
    const code = Object.entries(COLOR_CODES).find(
      ([, v]) => v.toLowerCase() === component.color?.toLowerCase()
    );
    if (code) result += `§${code[0]}`;
  }
  if (component.bold) result += '§l';
  if (component.italic) result += '§o';
  if (component.underlined) result += '§n';
  if (component.strikethrough) result += '§m';
  if (component.text) result += component.text;
  if (component.extra) {
    for (const extra of component.extra) {
      result += componentToRaw(extra);
    }
  }
  return result;
}

export function cleanMotd(raw: string): string {
  return raw.replace(/§[0-9a-fk-or]/gi, '');
}

export function motdToHtml(raw: string): string {
  let html = '';
  let currentColor: string | null = null;
  let openTags: string[] = [];
  const chars = raw.split('');

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '§' && i + 1 < chars.length) {
      const code = chars[i + 1].toLowerCase();
      i++;

      if (code === 'r') {
        html += openTags.reverse().join('');
        openTags = [];
        currentColor = null;
        continue;
      }

      if (COLOR_CODES[code]) {
        if (currentColor) {
          html += '</span>';
        }
        currentColor = COLOR_CODES[code];
        html += `<span style="color: ${currentColor}">`;
        openTags.push('</span>');
        continue;
      }

      if (FORMAT_CODES[code]) {
        html += FORMAT_CODES[code].open;
        openTags.push(FORMAT_CODES[code].close);
        continue;
      }
    } else {
      html += escapeHtml(chars[i]);
    }
  }

  html += openTags.reverse().join('');
  return html;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
